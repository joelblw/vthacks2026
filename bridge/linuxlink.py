#!/usr/bin/env python3
"""LinuxLink live-image bridge. Python 3.11+, no third-party dependencies."""
import argparse
import codecs
import glob
import json
import os
import queue
import selectors
import signal
import subprocess
import threading
import time
from pathlib import Path
from phone_ai import PhoneAI

MAX_LINE = 2048
MAX_OUTPUT = 128 * 1024


def environment():
    live = Path('/run/archiso/airootfs').exists() or Path('/run/archiso/bootmnt').exists()
    return dict(os='linux', shell='bash', live=live,
                default_mode='install' if live else 'troubleshoot')


def encode(message):
    return (json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n").encode()


class Framer:
    def __init__(self):
        self.buffer = bytearray()
        self.overflow = False

    def feed(self, data):
        for byte in data:
            if byte == 10:
                line = bytes(self.buffer)
                overflow = self.overflow
                self.buffer.clear()
                self.overflow = False
                if overflow:
                    yield {"id": "", "op": "invalid", "reason": "Frame too large"}
                    continue
                try:
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError("Expected an object")
                    yield value
                except (ValueError, UnicodeError):
                    yield {"id": "", "op": "invalid", "reason": "Invalid JSON"}
            elif not self.overflow:
                if len(self.buffer) >= MAX_LINE:
                    self.overflow = True
                else:
                    self.buffer.append(byte)


class Runner:
    def __init__(self, send):
        self.send = send
        self.lock = threading.RLock()
        self.thread = None
        self.stop = threading.Event()
        self.active_id = None
        self.seen = set()

    def handle(self, request):
        request_id = request.get("id")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
            self.send({"id": "", "type": "error", "message": "A 1–64 character string id is required"})
            return
        op = request.get("op")
        if op == "ping":
            self.send({"id": request_id, "type": "ready", "protocol": 1,
                       "message": "Arch bridge connected", "root": os.geteuid() == 0,
                       "environment": environment()})
        elif op == "cancel":
            with self.lock:
                if request.get("target") != self.active_id or self.active_id is None:
                    self.send({"id": request_id, "type": "error", "message": "No matching active command"})
                    return
                self.stop.set()
            self.send({"id": request_id, "type": "cancel", "message": "Cancellation requested"})
        elif op == "exec":
            command = request.get("command")
            timeout = request.get("timeout", 120)
            if not isinstance(command, str) or not command.strip() or len(command.encode()) > 1200 or "\0" in command:
                self.send({"id": request_id, "type": "error", "message": "Command must be 1–1200 UTF-8 bytes"})
                return
            if type(timeout) is not int or not 1 <= timeout <= 3600:
                self.send({"id": request_id, "type": "error", "message": "Timeout must be 1–3600 seconds"})
                return
            with self.lock:
                if self.thread is not None and self.thread.is_alive():
                    self.send({"id": request_id, "type": "error", "message": "Another command is running"})
                    return
                if request_id in self.seen:
                    self.send({"id": request_id, "type": "error", "message": "Duplicate command id; not executed again"})
                    return
                if len(self.seen) >= 10000:
                    self.send({"id": request_id, "type": "error", "message": "Session limit reached; restart bridge"})
                    return
                self.seen.add(request_id)
                self.active_id = request_id
                self.stop.clear()
                self.thread = threading.Thread(target=self._run, args=(request_id, command, timeout), daemon=True)
                self.thread.start()
        else:
            self.send({"id": request_id, "type": "error", "message": request.get("reason", "Unknown operation")})

    def _run(self, request_id, command, timeout):
        process = None
        command_lock = None
        selector = selectors.DefaultSelector()
        reason = "completed"
        total = 0
        decoders = {name: codecs.getincrementaldecoder("utf-8")("replace") for name in ("stdout", "stderr")}
        try:
            import fcntl
            command_lock = open('/tmp/linuxlink-command.lock', 'a')
            try:
                fcntl.flock(command_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise OSError('Another phone or console command is running')
            process = subprocess.Popen(["/bin/bash", "-lc", command], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                       env={**os.environ, "TERM": "dumb", "LC_ALL": "C.UTF-8"})
            self.send({"id": request_id, "type": "started"})
            for name in decoders:
                stream = getattr(process, name)
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            deadline = time.monotonic() + timeout
            killed_at = None
            while selector.get_map() or process.poll() is None:
                now = time.monotonic()
                if killed_at is None and (self.stop.is_set() or now >= deadline or total >= MAX_OUTPUT):
                    reason = "cancelled" if self.stop.is_set() else "timeout" if now >= deadline else "output_limit"
                    self._kill(process)
                    killed_at = now
                if killed_at is not None and now - killed_at > 2:
                    break
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fd, 192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        text = decoders[key.data].decode(b"", final=True)
                    else:
                        allowed = chunk[:max(0, MAX_OUTPUT - total)]
                        total += len(allowed)
                        text = decoders[key.data].decode(allowed)
                    if text:
                        self.send({"id": request_id, "type": key.data, "data": text})
            code = process.wait(timeout=3)
            self.send({"id": request_id, "type": "exit", "code": code, "reason": reason})
        except Exception as error:
            if process:
                self._kill(process)
                process.wait(timeout=3)
            self.send({"id": request_id, "type": "error", "message": str(error)})
        finally:
            # Do not leave background children alive after their shell exits.
            if process:
                self._kill(process)
                process.stdout.close()
                process.stderr.close()
            selector.close()
            if command_lock:
                command_lock.close()
            with self.lock:
                self.active_id = None

    @staticmethod
    def _kill(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=5)


def open_serial(path):
    import termios
    import tty
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    tty.setraw(fd)
    settings = termios.tcgetattr(fd)
    settings[4] = settings[5] = termios.B115200
    settings[2] |= termios.CLOCAL | termios.CREAD
    termios.tcsetattr(fd, termios.TCSANOW, settings)
    return fd


def serve(path, phone_ai=None):
    fd = open_serial(path)
    outgoing = queue.Queue(maxsize=64)
    closed = threading.Event()

    def send(message):
        packet = encode(message)
        if len(packet) > MAX_LINE + 1:
            packet = encode({"id": message.get("id", ""), "type": "error", "message": "Response too large"})
        while not closed.is_set():
            try:
                outgoing.put(packet, timeout=0.2)
                return
            except queue.Full:
                if threading.current_thread() is threading.main_thread():
                    raise OSError("Output queue full; closing stalled session")
                continue

    runner = Runner(send)
    if phone_ai:
        phone_ai.attach(send)
    framer = Framer()
    pending = b""
    last_progress = time.monotonic()
    selector = selectors.DefaultSelector()
    selector.register(fd, selectors.EVENT_READ)
    try:
        while True:
            if not pending:
                try:
                    pending = outgoing.get_nowait()
                    last_progress = time.monotonic()
                except queue.Empty:
                    pass
            selector.modify(fd, selectors.EVENT_READ | (selectors.EVENT_WRITE if pending else 0))
            for _, events in selector.select(0.1):
                if events & selectors.EVENT_READ:
                    data = os.read(fd, 4096)
                    if not data:
                        raise OSError("USB disconnected")
                    for request in framer.feed(data):
                        if phone_ai and request.get('op') == 'ping' and 'chat_capabilities' in request:
                            phone_ai.compression = 'deflate' in request.get('chat_capabilities', [])
                        if phone_ai and request.get('op') == 'ping' and any(key in request for key in ('chat_reply', 'chat_received', 'chat_notice')):
                            try:
                                if 'chat_received' in request:
                                    phone_ai.acknowledge(request['chat_received'])
                                elif 'chat_notice' in request:
                                    phone_ai.notice(request['chat_notice'])
                                else:
                                    phone_ai.reply(request['chat_reply'])
                                send({'id':request.get('id'), 'type':'chat_ack'})
                            except (ValueError, AttributeError, OSError) as error:
                                send({'id':request.get('id'), 'type':'error', 'message':str(error)})
                        else:
                            runner.handle(request)
                if events & selectors.EVENT_WRITE:
                    count = os.write(fd, pending)
                    pending = pending[count:]
                    last_progress = time.monotonic()
            if pending and time.monotonic() - last_progress > 15:
                raise OSError("USB output stalled")
    finally:
        closed.set()
        if phone_ai:
            phone_ai.detach()
        runner.close()
        selector.close()
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", help="Explicit serial device; default discovers the LinuxLink USB serial number")
    args = parser.parse_args()
    phone_ai = PhoneAI()
    phone_ai.start()
    while True:
        try:
            matches = glob.glob("/dev/serial/by-id/*LINUXLINK-S3-001*")
            if not args.device and len(matches) != 1:
                raise OSError("Waiting for exactly one LinuxLink USB device")
            path = args.device or matches[0]
            print(f"Connecting to {path}", flush=True)
            serve(path, phone_ai)
        except (OSError, ValueError) as error:
            print(error, flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
