#!/usr/bin/env python3
"""Local Arch console chat, relayed through the paired phone."""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import time
import urllib.error
import uuid
import threading
import argparse

from linuxlink import Runner, environment
from phone_ai import RelayBackend, UPDATES

DEFAULTS = dict(desktop='gnome', hostname='archlinux', username='linuxuser',
                timezone='UTC', locale='en_US.UTF-8', filesystem='ext4', encryption=False, dual_boot=False)
INSPECT = 'lsblk --json --paths -o NAME,SIZE,MODEL,TYPE,MOUNTPOINTS,TRAN'


def install_request(text):
    if re.search(r"\?|\b(don't|do not|never|avoid|keep|preserve|dual.boot)\b|without\s+(erasing|formatting|wiping)", text, re.I):
        return False
    return bool(re.search(r'^(?:(?:please|just)\s+)*(?:install|set up)\s+(?:arch(?:\s+linux)?|linux)(?:[.!]|$|\s+(?:on|with|using|for|without)\b)', text.strip(), re.I))


def clean(text):
    # Do not let model/command output inject terminal control sequences.
    return ''.join(c for c in str(text) if c in '\n\t' or (ord(c) >= 32 and ord(c) != 127))


def eligible(data):
    def mounted(node):
        return any(node.get('mountpoints') or []) or any(mounted(c) for c in node.get('children', []))
    return [d for d in data.get('blockdevices', []) if d.get('type') == 'disk'
            and d.get('tran') != 'usb' and not mounted(d)
            and re.fullmatch(r'/dev/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|mmcblk\d+)', d.get('name', ''))]


class Console:
    def __init__(self, backend, reader=input, mode='install'):
        if mode not in ('install', 'troubleshoot'):
            raise ValueError('Unknown assistant mode')
        self.mode = mode
        self.backend, self.reader = backend, reader
        self.conversation, self.answers = [], []
        self.state, self.transcript, self.proposed = '', '', ''
        self.disk, self.disks = None, []
        self.completed = set()
        self.recoverable = False

    def update(self, text):
        print(clean(text), flush=True)
        notify = getattr(self.backend, 'notify', None)
        if notify:
            notify(text)

    def run_command(self, command):
        events = queue.Queue()
        runner = Runner(events.put)
        request_id = str(uuid.uuid4())
        self.recoverable = False
        self.update('Running the next step...')
        self.transcript = (self.transcript + '\n$ ' + command + '\n')[-12000:]
        runner.handle(dict(id=request_id, op='exec', command=command, timeout=1800))
        try:
            while True:
                try:
                    message = events.get(timeout=30)
                except queue.Empty:
                    self.update('This step is still running. Ctrl+C stops it.')
                    continue
                kind = message['type']
                if kind in ('stdout', 'stderr'):
                    text = message.get('data', '')
                    self.transcript = (self.transcript + text)[-12000:]
                elif kind in ('exit', 'error'):
                    result = json.dumps(message)
                    self.transcript = (self.transcript + '\n' + result)[-12000:]
                    success = kind == 'exit' and message['code'] == 0 and message['reason'] == 'completed'
                    if success:
                        self.completed.add(command.strip())
                    self.recoverable = kind == 'exit' and message.get('reason') == 'completed'
                    self.update('Step finished.' if success else 'This step encountered a problem. I’ll check the result and work out the next step.' if self.recoverable else 'The step stopped before completion; installation is paused.')
                    return success
        except KeyboardInterrupt:
            self.transcript = (self.transcript + '\n[Command interrupted; inspect partial changes before continuing.]')[-12000:]
            print('\nCommand stopped. Automatic installation paused.')
            return False
        finally:
            runner.close()

    def inspect(self):
        result = subprocess.run(INSPECT.split(), capture_output=True, text=True, timeout=15, check=True)
        self.disks = eligible(json.loads(result.stdout))
        self.transcript = (self.transcript + '\nDisk inspection:\n' + result.stdout)[-12000:]
        for disk in self.disks:
            print(clean(f"{disk['name']}  {disk.get('size')}  {disk.get('model', '')}"))
        if not self.disks:
            print('No unmounted internal disks found. Use chat to diagnose existing mounts; do not erase again to resume.')

    def ask(self, goal, automatic=False):
        if not automatic:
            if sum(map(len, self.answers)) + len(goal) > 10000:
                raise ValueError('Session notes are full. Exit and inspect progress before beginning another session.')
            self.answers.append(goal)
        print('Thinking... (Ctrl+C returns to the prompt)', flush=True)
        proposal = self.backend.plan(goal, self.transcript, self.conversation,
            dict(mode=self.mode, environment=environment(), authorized_disk=self.disk if self.mode == 'install' else None, inspected_disks=self.disks, automatic=automatic,
                 defaults=DEFAULTS, saved_state=self.state, user_answers=self.answers))
        self.state = proposal.get('state', self.state)
        self.conversation.extend([dict(role='user', content=goal), dict(role='assistant', content=proposal['explanation'])])
        while len(json.dumps(self.conversation)) > 16000:
            self.conversation.pop(0)
        print('\nLinuxLink: ' + clean(proposal['explanation']))
        self.proposed = proposal['command'].strip()
        if self.proposed and not automatic:
            print('Type /run to execute the suggested step, or send another message.')
        return proposal

    def automatic(self, goal=None):
        if self.mode == 'install' and not self.disk:
            print('Use /disks, then /disk /dev/your-disk to authorize the installation target first.')
            return
        if goal:
            if sum(map(len, self.answers)) + len(goal) > 10000:
                raise ValueError('Session notes are full; start a new session.')
            self.answers.append(goal)
        for step in range(60):
            next_goal = 'Continue the user’s requested troubleshooting or task using actual results and saved state. Diagnose problems and verify the outcome.' if self.mode == 'troubleshoot' else 'Continue installation from actual results and saved preferences; use basic defaults for missing preferences. Inspect before resuming existing work.'
            proposal = self.ask(goal if step == 0 and goal else next_goal, automatic=True)
            if not self.proposed or proposal.get('status') != 'working':
                print('Ready for your next message.' if proposal.get('status') == 'conversation' else 'Finished or paused as described above.')
                return
            if self.mode == 'install' and self.proposed in self.completed:
                print('Paused: the AI repeated an already successful command.')
                return
            if not self.run_command(self.proposed) and not self.recoverable:
                self.proposed = ''
                self.update('Paused because the command was interrupted or its outcome is unknown.')
                return
            self.proposed = ''
        print('Paused after 60 steps. Check progress before /auto to resume.')

    def install(self, goal):
        if self.mode != 'install':
            raise ValueError('Switch to /mode install to install an operating system.')
        self.proposed = ''
        requested = re.findall(r'/dev/[A-Za-z0-9/_-]+', goal)
        if not self.disk or requested:
            self.inspect()
            if requested:
                if len(set(requested)) != 1 or requested[0] not in [d['name'] for d in self.disks]:
                    raise ValueError('Specify one eligible internal disk from /disks.')
                self.disk = requested[0]
            elif len(self.disks) == 1:
                self.disk = self.disks[0]['name']
            else:
                raise ValueError('There is not exactly one eligible disk. Specify a target with /disk DEVICE, then /auto.')
        self.answers.append(goal)
        self.answers.append(f'Test installation: erasure of {self.disk} and automatic execution are authorized. Use defaults without asking for confirmation.')
        print(f'Starting automatic test installation on {self.disk}. Ctrl+C pauses it.')
        self.automatic()

    def loop(self):
        print('\nLinuxLink — chat with your computer assistant\n'
              'Type a request, or use /disks, /disk DEVICE, /run, /auto, /help.\n'
              'Type quit or exit to return to the regular Arch terminal.\n'
              'Keep the phone app connected/open and the Windows companion running.\n'
              'Chat/output are sent to your AI provider. Do not enter passwords in chat.\n')
        print('Mode: ' + self.mode + '. Use /mode install or /mode troubleshoot to switch.\n')
        if self.mode == 'install':
            print('Test mode: "install linux" selects the only eligible internal disk and installs without confirmations.\n')
        while True:
            try:
                text = self.reader('You> ').strip()
                if text.lower() in ('quit', 'exit'):
                    return
                if not text:
                    continue
                if text == '/help':
                    print('/mode install or /mode troubleshoot: switch mode and clear previous task context')
                    print('/disks: inspect disks\n/disk DEVICE: authorize erasing the selected disk\n/run: run the last suggestion\n/auto: install using preferences or GNOME/archlinux/linuxuser/UTC defaults\nCtrl+C: stop the current operation\nquit or exit: regular terminal\nRestart chat from the terminal: linuxlink-chat')
                elif text.startswith('/mode '):
                    new_mode = text[6:].strip()
                    if new_mode not in ('install', 'troubleshoot'):
                        raise ValueError('Use /mode install or /mode troubleshoot.')
                    self.__init__(self.backend, self.reader, new_mode)
                    print('Mode: ' + self.mode + '. Previous task context cleared.')
                elif text == '/disks':
                    self.inspect()
                elif text.startswith('/disk '):
                    if self.mode != 'install':
                        raise ValueError('Disk erasure authorization is available only in installation mode.')
                    disk = text[6:].strip()
                    self.inspect()
                    if disk not in [d['name'] for d in self.disks]:
                        print('Choose a listed internal disk.')
                        continue
                    self.disk = disk
                    self.answers.append(f'I authorize erasing only {disk} for Arch installation.')
                    print('Erasure authorized for ' + disk + '. Type /auto to start installation.')
                elif text == '/auto':
                    self.automatic()
                elif text == '/run':
                    if self.proposed:
                        command, self.proposed = self.proposed, ''
                        self.run_command(command)
                    else:
                        print('No pending command. Ask the assistant for a step first.')
                elif self.mode == 'troubleshoot':
                    self.proposed = ''
                    self.automatic(text)
                elif install_request(text):
                    self.install(text)
                else:
                    self.proposed = ''
                    self.ask(text)
            except EOFError:
                return
            except KeyboardInterrupt:
                self.proposed = ''
                print('\nPaused. Type quit or exit for the regular terminal.')
            except urllib.error.HTTPError as error:
                self.proposed = ''
                print(f'AI provider HTTP {error.code}. Check quota/billing for 429, or retry later for 5xx. Conversation retained.')
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                self.proposed = ''
                # Never print provider exceptions containing a URL/key.
                print(clean(str(error)) if isinstance(error, ValueError) else f'Operation failed ({type(error).__name__}). Check the LinuxLink bridge and phone connection. Conversation retained.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('install', 'troubleshoot'), default=environment()['default_mode'])
    args = parser.parse_args()
    stopped = threading.Event()
    def updates():
        offset = 0
        while not stopped.wait(0.2):
            try:
                path = Path(UPDATES)
                if path.stat().st_size < offset:
                    offset = 0
                with path.open('rb') as stream:
                    stream.seek(offset)
                    for raw in stream:
                        if not raw.endswith(b'\n'):
                            break
                        print('\nLinuxLink: ' + clean(json.loads(raw)['text']), flush=True)
                        offset += len(raw)
            except (OSError, ValueError, KeyError):
                pass
    worker = threading.Thread(target=updates, daemon=True)
    worker.start()
    try:
        Console(RelayBackend(), mode=args.mode).loop()
    finally:
        stopped.set()


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nReturning to the Arch terminal.')
