"""Local console <-> phone AI relay, using existing USB/BLE frames."""
import base64
import json
import os
import socket
import select
import time
import threading
import uuid
import zlib
from pathlib import Path

SOCKET = '/run/linuxlink-chat.sock'
LIMIT = 65536
CHUNK_SIZE = 768
ACK_TIMEOUT = 20
UPDATES = '/run/linuxlink-updates.jsonl'


class PhoneAI:
    def __init__(self):
        self.sender = None
        self.pending = {}
        self.lock = threading.Lock()
        self.busy = threading.Lock()
        self.compression = False

    def attach(self, sender):
        with self.lock:
            self.sender = sender
            self.compression = False

    def notice(self, text):
        if not isinstance(text, str) or len(text) > 6000:
            raise ValueError('Invalid chat update')
        path = Path(UPDATES)
        mode = 'w' if path.exists() and path.stat().st_size > 1000000 else 'a'
        with path.open(mode, encoding='utf-8') as stream:
            stream.write(json.dumps(dict(text=text)) + '\n')

    def detach(self):
        with self.lock:
            self.sender = None
            for entry in self.pending.values():
                entry['error'] = 'Device connection ended. Reconnect the phone and retry.'
                entry['event'].set()
                entry['ack'].set()

    def acknowledge(self, packet):
        with self.lock:
            entry = self.pending.get(packet.get('id'))
            if entry is None or packet.get('seq') != entry['out_seq']:
                raise ValueError('Console chunk acknowledgement expired or out of order')
            entry['ack'].set()

    def reply(self, packet):
        with self.lock:
            entry = self.pending.get(packet.get('id'))
            if entry is None:
                raise ValueError('Console request expired')
            chunk = packet.get('chunk')
            if (packet.get('seq') != entry['seq'] or not isinstance(chunk, str)
                    or len(chunk) > 1200 or len(entry['data']) + len(chunk) > LIMIT * 2):
                raise ValueError('Invalid console reply chunk')
            entry['data'] += chunk
            entry['seq'] += 1
            if packet.get('end') is True:
                entry['event'].set()

    def handle(self, connection):
        with connection:
            acquired = False
            request_id = str(uuid.uuid4())
            result = {'error':'Console request failed'}
            try:
                connection.settimeout(240)
                with connection.makefile('rb') as stream:
                    raw = stream.readline(LIMIT + 1)
                    if len(raw) > LIMIT or not raw.endswith(b'\n'):
                        raise ValueError('Console request too large')
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise ValueError('Invalid console request')
                    if body.get('op') == 'notice':
                        text = body.get('text')
                        if not isinstance(text, str) or len(text) > 500:
                            raise ValueError('Invalid progress update')
                        with self.lock:
                            sender = self.sender
                        if sender:
                            sender(dict(id=request_id, type='chat_update', text=text))
                        connection.sendall(b'{"ok":true}\n')
                        return
                    acquired = self.busy.acquire(blocking=False)
                    if not acquired:
                        raise ValueError('Another computer chat request is running.')
                    entry = dict(event=threading.Event(), ack=threading.Event(), out_seq=-1, seq=0, data='', error=None)
                    with self.lock:
                        self.pending[request_id] = entry
                        sender = self.sender
                    if sender is None:
                        raise ValueError('USB bridge is not connected. Connect LinuxLink and the phone first.')
                    compression = self.compression
                    encoded = base64.b64encode(zlib.compress(raw) if compression else raw).decode('ascii')
                    for seq, offset in enumerate(range(0, len(encoded), CHUNK_SIZE)):
                        with self.lock:
                            entry['out_seq'] = seq
                            entry['ack'].clear()
                            if entry['error']:
                                raise ValueError(entry['error'])
                        sender(dict(id=request_id, type='chat_request', seq=seq,
                                    chunk=encoded[offset:offset+CHUNK_SIZE], end=offset+CHUNK_SIZE >= len(encoded), flow='ack', encoding='deflate' if compression else 'base64'))
                        # USB is faster than BLE indications. Never fill the ESP32
                        # USB buffer with a second chunk before the phone got this one.
                        if not entry['ack'].wait(ACK_TIMEOUT):
                            raise ValueError('Phone did not acknowledge the chat chunk. Refresh the phone app, reconnect Bluetooth and retry.')
                        if entry['error']:
                            raise ValueError(entry['error'])
                    deadline = time.monotonic() + 180
                    while not entry['event'].wait(0.25):
                        if select.select([connection], [], [], 0)[0] and not connection.recv(1, socket.MSG_PEEK):
                            raise ValueError('Console closed')
                        if time.monotonic() >= deadline:
                            raise ValueError('Phone did not reply. Keep the phone app open and connected, and the Windows companion running.')
                    if entry['error']:
                        raise ValueError(entry['error'])
                    response = base64.b64decode(entry['data'], validate=True)
                    value = json.loads(response)
                    if not isinstance(value, dict):
                        raise ValueError('Invalid phone reply')
                    result = value
            except (OSError, ValueError) as error:
                result = {'error':str(error)}
            finally:
                with self.lock:
                    self.pending.pop(request_id, None)
                if acquired:
                    self.busy.release()
            # Release the session before the console can send its next turn.
            try:
                connection.sendall(json.dumps(result).encode() + b'\n')
            except OSError:
                pass

    def start(self):
        if os.path.exists(SOCKET):
            os.unlink(SOCKET)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(SOCKET)
        os.chmod(SOCKET, 0o600)
        listener.listen(2)
        def accept():
            while True:
                connection, _ = listener.accept()
                threading.Thread(target=self.handle, args=(connection,), daemon=True).start()
        threading.Thread(target=accept, daemon=True).start()


class RelayBackend:
    def notify(self, text):
        # Progress is best effort and must never interrupt an installation.
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2)
                connection.connect(SOCKET)
                connection.sendall(json.dumps(dict(op='notice', text=text[:500])).encode() + b'\n')
                connection.recv(1024)
        except OSError:
            pass

    def plan(self, goal, transcript, conversation, installation_context):
        body = dict(goal=goal, transcript=transcript, conversation=conversation,
                    installation_context=installation_context)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(240)
            connection.connect(SOCKET)
            connection.sendall(json.dumps(body).encode() + b'\n')
            with connection.makefile('rb') as stream:
                raw = stream.readline(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError('Phone response too large')
            result = json.loads(raw)
            if result.get('error'):
                raise ValueError(result['error'])
            if not isinstance(result.get('explanation'), str) or not isinstance(result.get('command'), str):
                raise ValueError('Invalid AI response')
            return result
