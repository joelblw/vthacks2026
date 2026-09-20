import io
import json
from pathlib import Path
import sys
import unittest
import tempfile
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class AgentTests(unittest.TestCase):
    def test_modes_have_separate_workflows(self):
        self.assertEqual(server.instructions_for({}), server.INSTRUCTIONS)
        prompt = server.instructions_for({'mode':'troubleshoot','authorized_disk':'/dev/vda'})
        self.assertEqual(prompt, server.TROUBLESHOOT_INSTRUCTIONS)
        self.assertNotIn('Finish package installation, fstab', prompt)
        self.assertIn('not OS installation', prompt)
        with self.assertRaises(ValueError):
            server.instructions_for({'mode':'unknown'})

    def test_agent_progress_is_validated(self):
        proposal = {'explanation':'Next step', 'command':'lsblk', 'state':'Use KDE; installation not complete', 'status':'working'}
        self.assertEqual(server.validate_proposal(proposal), proposal)
        conversation = dict(explanation='Hi! How’s it going?', command='', state=proposal['state'], status='conversation')
        self.assertEqual(server.validate_proposal(conversation), conversation)
        with self.assertRaises(ValueError):
            server.validate_proposal({**conversation, 'command':'lsblk'})
        for invalid in ({**proposal,'status':'complete'}, {**proposal,'command':''}, {**proposal,'state':'x'*3001}):
            with self.assertRaises(ValueError):
                server.validate_proposal(invalid)

    def test_connection_failure_retries_and_longer_responses_are_allowed(self):
        for failure in (TimeoutError(), ConnectionResetError(), urllib.error.URLError('temporary DNS error')):
            with patch('urllib.request.urlopen', side_effect=[failure, io.BytesIO(b'{}')]) as call, patch('server.time.sleep'):
                self.assertEqual(server.provider_json(object()), {})
                self.assertEqual(call.call_count, 2)
                self.assertEqual(call.call_args_list[0].kwargs['timeout'], 45)

    def test_deadline_prevents_unbounded_retries(self):
        with patch('server.time.monotonic', side_effect=[0, 0, 54]), patch('server.time.sleep') as sleep, patch('urllib.request.urlopen', side_effect=TimeoutError()) as call:
            with self.assertRaises(TimeoutError):
                server.provider_json(object())
            self.assertEqual(call.call_count, 1)
            sleep.assert_not_called()

    def test_transient_provider_errors_retry_but_auth_does_not(self):
        def error(code):
            return urllib.error.HTTPError('https://example.test', code, 'test', {}, None)
        with patch('urllib.request.urlopen', side_effect=[error(503), error(503), io.BytesIO(b'{}')]) as call, patch('server.time.sleep') as sleep:
            self.assertEqual(server.provider_json(object()), {})
            self.assertEqual(call.call_count, 3)
            self.assertEqual([x.args[0] for x in sleep.call_args_list], [1, 2])
        for code, count in [(503, 3), (401, 1), (429, 1)]:
            with patch('urllib.request.urlopen', side_effect=lambda *a, **kw: (_ for _ in ()).throw(error(code))) as call, patch('server.time.sleep'):
                with self.assertRaises(urllib.error.HTTPError):
                    server.provider_json(object())
                self.assertEqual(call.call_count, count)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name) / 'settings.json'
        self.patcher = patch.object(server, 'CONFIG', self.config)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    @patch.dict('os.environ', {'LINUXLINK_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-secret', 'OPENAI_MODEL': 'test-model'})
    def test_proposal_and_server_side_key(self):
        result = {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'explanation':'Inspect disks','command':'lsblk --json'})}]}]}
        with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(result).encode())) as call:
            self.assertEqual(server.plan('Inspect my disks','test output',installation_context={'mode':'troubleshoot'})['command'], 'lsblk --json')
            request = call.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'), 'Bearer test-secret')
            body = json.loads(request.data)
            self.assertEqual(body['instructions'],server.TROUBLESHOOT_INSTRUCTIONS)
            self.assertFalse(body['store'])
            self.assertTrue(body['text']['format']['strict'])
            self.assertNotIn('test-secret', request.data.decode())

    @patch.dict('os.environ', {'LINUXLINK_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test', 'OPENAI_MODEL': 'test'})
    def test_incomplete_result_never_becomes_a_command(self):
        with patch('urllib.request.urlopen', return_value=io.BytesIO(b'{"status":"incomplete"}')):
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                server.plan('install','')

    @patch.dict('os.environ', {'LINUXLINK_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test-google-secret', 'GEMINI_MODEL': 'gemini-3.6-flash'})
    def test_gemini_structured_proposal(self):
        result = {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [
            {'thought': True, 'text': 'not output'},
            {'text': json.dumps({'explanation': 'Inspect disks', 'command': 'lsblk --json'})}]}}]}
        with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(result).encode())) as call:
            self.assertEqual(server.plan('Check disks', 'output')['command'], 'lsblk --json')
            request = call.call_args.args[0]
            self.assertIn('generativelanguage.googleapis.com', request.full_url)
            self.assertNotIn('test-google-secret', request.full_url)
            self.assertEqual(request.get_header('X-goog-api-key'), 'test-google-secret')
            self.assertEqual(json.loads(request.data)['generationConfig']['responseJsonSchema'], server.SCHEMA)
            self.assertEqual(json.loads(request.data)['systemInstruction']['parts'][0]['text'],server.INSTRUCTIONS)

    @patch.dict('os.environ', {'LINUXLINK_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test', 'GEMINI_MODEL': 'gemini-3.6-flash'})
    def test_gemini_blocked_or_truncated_response_is_rejected(self):
        for reason in ('SAFETY', 'MAX_TOKENS'):
            result = {'candidates': [{'finishReason': reason}]}
            with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(result).encode())):
                with self.assertRaisesRegex(ValueError, 'completed'):
                    server.plan('Check disks', '')

    @patch.dict('os.environ', {}, clear=True)
    def test_local_settings_reload_and_environment_override(self):
        self.config.write_text(json.dumps({'provider':'gemini','model':'gemini-3.6-flash','api_key':'private','access_token':'a'*32}))
        self.assertEqual(server.settings()['key'], 'private')
        with patch.dict('os.environ', {'GEMINI_API_KEY':'override'}):
            self.assertEqual(server.settings()['key'], 'override')
        self.config.write_text(json.dumps({'provider':'gemini','model':'bad/model'}))
        with self.assertRaisesRegex(ValueError, 'Invalid model'):
            server.settings()


if __name__ == '__main__':
    unittest.main()
