import base64
import contextlib
import io
import json
from pathlib import Path
import socket
import sys
import threading
import zlib
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from console import Console, eligible, install_request
from phone_ai import PhoneAI


class ConsoleTests(unittest.TestCase):
    def test_troubleshooting_runs_without_disk_and_clears_install_authorization(self):
        backend = Mock()
        backend.plan.side_effect = [
            dict(explanation='Check network', command='ip link', status='working'),
            dict(explanation='Verified', command='', status='complete')]
        entries = iter(['/mode troubleshoot','Fix Wi-Fi','exit'])
        console = Console(backend, reader=lambda prompt:next(entries))
        console.disk = '/dev/vda'; console.answers.append('I authorize erasing /dev/vda')
        with patch.object(Console, 'run_command', return_value=True) as run, contextlib.redirect_stdout(io.StringIO()):
            console.loop()
        run.assert_called_once_with('ip link')
        context = backend.plan.call_args_list[0].args[3]
        self.assertEqual(context['mode'], 'troubleshoot')
        self.assertIsNone(context['authorized_disk'])
        self.assertEqual(context['user_answers'], ['Fix Wi-Fi'])
        with self.assertRaisesRegex(ValueError, 'Switch'):
            console.install('install linux')

    def test_compressed_relay_and_notices(self):
        broker = PhoneAI()
        packets = []
        body = dict(goal='Hello', transcript='package progress ' * 1500)
        def sender(packet):
            packets.append(packet)
            if packet['type'] != 'chat_request':
                return
            broker.acknowledge(dict(id=packet['id'],seq=packet['seq']))
            if packet['end']:
                decoded = zlib.decompress(base64.b64decode(''.join(p['chunk'] for p in packets)))
                self.assertEqual(json.loads(decoded), body)
                broker.reply(dict(id=packet['id'],seq=0,chunk=base64.b64encode(b'{"explanation":"Hi","command":""}').decode(),end=True))
        broker.attach(sender)
        broker.compression = True
        for request in (body, dict(op='notice',text='Checking the network')):
            client, server = socket.socketpair()
            worker = threading.Thread(target=broker.handle,args=(server,)); worker.start()
            with client:
                client.settimeout(3)
                client.sendall(json.dumps(request).encode()+b'\n')
                self.assertNotIn('error', json.loads(client.recv(4096)))
            worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertLess(sum(len(p.get('chunk','')) for p in packets), 1000)
        self.assertEqual(packets[-1]['type'], 'chat_update')
        self.assertEqual(packets[-1]['text'], 'Checking the network')
        with tempfile.TemporaryDirectory() as folder, patch('phone_ai.UPDATES', str(Path(folder)/'updates')):
            broker.notice('Working on the network')
            broker.notice('Continuing installation')
            updates = [json.loads(line)['text'] for line in (Path(folder)/'updates').read_text().splitlines()]
            self.assertEqual(updates, ['Working on the network','Continuing installation'])

    def test_command_output_is_retained_but_not_displayed(self):
        console = Console(Mock())
        def runner(send):
            instance = Mock()
            def handle(request):
                send(dict(type='stdout', data='RAW COMMAND OUTPUT'))
                send(dict(type='exit', code=1, reason='completed'))
            instance.handle.side_effect = handle
            return instance
        screen = io.StringIO()
        with patch('console.Runner', side_effect=runner), contextlib.redirect_stdout(screen):
            self.assertFalse(console.run_command('secret-command'))
        self.assertTrue(console.recoverable)
        self.assertIn('RAW COMMAND OUTPUT', console.transcript)
        self.assertNotIn('RAW COMMAND OUTPUT', screen.getvalue())
        self.assertNotIn('secret-command', screen.getvalue())
        console.backend.notify.assert_called()

    def test_failed_step_is_followed_by_repair_without_user_input(self):
        backend = Mock()
        backend.plan.side_effect = [
            dict(explanation='Install', command='first', status='working'),
            dict(explanation='Repair', command='repair', status='working'),
            dict(explanation='Done', command='', status='complete')]
        console = Console(backend)
        console.disk = '/dev/vda'
        def run(command):
            console.recoverable = True
            return command == 'repair'
        console.run_command = Mock(side_effect=run)
        with contextlib.redirect_stdout(io.StringIO()):
            console.automatic()
        self.assertEqual([call.args[0] for call in console.run_command.call_args_list], ['first', 'repair'])

    def test_large_repeated_requests_are_flow_controlled(self):
        broker = PhoneAI()
        first_chunk = threading.Event()
        packets = []
        def sender(packet):
            packets.append(packet)
            if len(packets) == 1:
                first_chunk.set()  # Deliberately withhold the first acknowledgement.
                return
            broker.acknowledge(dict(id=packet['id'], seq=packet['seq']))
            if packet['end']:
                response = base64.b64encode(b'{"explanation":"done","command":""}').decode()
                broker.reply(dict(id=packet['id'],seq=0,chunk=response,end=True))
        broker.attach(sender)
        for turn in range(3):
            packets.clear(); first_chunk.clear()
            client, server = socket.socketpair()
            worker = threading.Thread(target=broker.handle,args=(server,))
            worker.start()
            with client:
                client.settimeout(3)
                client.sendall(json.dumps({'goal':str(turn), 'transcript':'x'*20000}).encode()+b'\n')
                self.assertTrue(first_chunk.wait(2))
                self.assertEqual(len(packets),1)
                self.assertFalse(broker.pending[packets[0]['id']]['ack'].is_set())
                broker.acknowledge(dict(id=packets[0]['id'],seq=0))
                self.assertEqual(json.loads(client.recv(4096))['explanation'],'done')
                self.assertFalse(broker.busy.locked())
                request = json.loads(base64.b64decode(''.join(p['chunk'] for p in packets)))
                self.assertEqual(request['transcript'],'x'*20000)
            worker.join(3)
            self.assertFalse(worker.is_alive())

    def test_missing_chunk_ack_releases_session(self):
        broker=PhoneAI(); broker.attach(lambda packet:None)
        client, server=socket.socketpair()
        with patch('phone_ai.ACK_TIMEOUT',0.01):
            worker=threading.Thread(target=broker.handle,args=(server,)); worker.start()
            with client:
                client.settimeout(2); client.sendall(b'{"goal":"test"}\n')
                self.assertIn('acknowledge',json.loads(client.recv(4096))['error'])
            worker.join(2)
        self.assertFalse(broker.busy.locked())
        self.assertFalse(broker.pending)

    def test_plain_install_starts_without_confirmation(self):
        console = Console(Mock(), reader=Mock(side_effect=AssertionError('Must not ask confirmation')))
        def inspect():
            console.disks = [dict(name='/dev/vda')]
        console.inspect = inspect
        console.automatic = Mock()
        with contextlib.redirect_stdout(io.StringIO()):
            console.install('install linux')
        self.assertEqual(console.disk, '/dev/vda')
        console.automatic.assert_called_once()
        self.assertIn('without asking for confirmation', console.answers[-1])
        console.disk = None
        console.inspect = lambda:None
        console.disks.append(dict(name='/dev/vdb'))
        with self.assertRaises(ValueError):
            console.install('install linux')
        self.assertFalse(install_request('install linux without erasing'))
        self.assertFalse(install_request('How do I install linux?'))
        self.assertTrue(install_request('Please install Arch Linux with KDE'))

    def test_quit_exit_and_eof_return_without_provider_or_commands(self):
        for word in ('quit', 'exit', 'EXIT'):
            backend = Mock()
            with contextlib.redirect_stdout(io.StringIO()):
                Console(backend, reader=lambda prompt:word).loop()
            backend.plan.assert_not_called()
        def eof(prompt):
            raise EOFError()
        with contextlib.redirect_stdout(io.StringIO()):
            Console(Mock(), reader=eof).loop()

    def test_chat_uses_phone_backend_and_remembers_answer(self):
        backend = Mock()
        backend.plan.return_value = dict(explanation='Ready',command='',state='KDE selected',status='needs_input')
        entries = iter(['Use KDE','exit'])
        console = Console(backend, reader=lambda prompt:next(entries))
        with contextlib.redirect_stdout(io.StringIO()):
            console.loop()
        self.assertEqual(console.state, 'KDE selected')
        self.assertEqual(console.answers, ['Use KDE'])

    def test_relay_roundtrip_over_local_socket(self):
        broker = PhoneAI()
        chunks=[]
        def sender(packet):
            chunks.append(packet['chunk'])
            broker.acknowledge(dict(id=packet['id'],seq=packet['seq']))
            if packet['end']:
                self.assertEqual(json.loads(base64.b64decode(''.join(chunks)))['goal'], 'Hello')
                response=base64.b64encode(b'{"explanation":"Hi","command":""}').decode()
                broker.reply(dict(id=packet['id'],seq=0,chunk=response,end=True))
        broker.attach(sender)
        client, server = socket.socketpair()
        worker=threading.Thread(target=broker.handle,args=(server,))
        worker.start()
        with client:
            client.settimeout(3)
            client.sendall(b'{"goal":"Hello"}\n')
            self.assertEqual(json.loads(client.recv(4096))['explanation'], 'Hi')
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertFalse(broker.pending)


if __name__ == '__main__':
    unittest.main()
