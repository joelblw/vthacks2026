import http.client
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class LocalAuthTests(unittest.TestCase):
    def setUp(self):
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.worker = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.port = self.http.server_address[1]
        config = patch.object(server, 'settings', return_value={'provider':'gemini','model':'test','key':'private','token':'a'*32})
        config.start()
        self.addCleanup(config.stop)
        planner = patch.object(server, 'plan', return_value={'explanation':'Hello', 'command':''})
        self.plan = planner.start()
        self.addCleanup(planner.stop)

    def request(self, method='POST', path='/api/test', extra=None, body='{}'):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        headers = {'Content-Type':'application/json', 'X-LinuxLink-Client':'web'}
        headers.update(extra or {})
        try:
            connection.request(method, path, body=body if method == 'POST' else None, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_localhost_works_without_token(self):
        status, info = self.request('GET', '/api/status')
        self.assertEqual(status, 200)
        self.assertFalse(info['auth_required'])
        self.assertNotIn('key', info)
        self.assertNotIn('token', info)
        self.assertEqual(self.request(extra={'Origin':f'http://127.0.0.1:{self.port}'})[0], 200)
        self.plan.assert_called_once()

    def test_cross_origin_rebinding_and_simple_posts_are_rejected(self):
        for headers in ({'Origin':'https://unrelated.example'}, {'Host':f'evil.example:{self.port}'},
                        {'X-LinuxLink-Client':''}, {'Content-Type':'text/plain'}):
            self.assertEqual(self.request(extra=headers)[0], 403)
        self.plan.assert_not_called()

    def test_network_listener_still_requires_token(self):
        # Simulate the same request arriving at a listener bound to all interfaces.
        self.http.server_address = ('0.0.0.0', self.port)
        self.assertTrue(self.request('GET', '/api/status')[1]['auth_required'])
        self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.request(extra={'Authorization':'Bearer ' + 'a'*32})[0], 200)

    def test_guided_installation_context_fits_request_limit(self):
        goal = 'Installation preferences and progress: ' + 'x' * 3000
        status, result = self.request(path='/api/plan', body=json.dumps({'goal':goal,'transcript':'inspection output'}))
        self.assertEqual(status, 200)
        self.plan.assert_called_once_with(goal, 'inspection output')

    def test_chat_history_and_invalid_roles(self):
        history = [{'role':'user','content':'Use KDE'}]
        context = {'authorized_disk':None, 'inspected_disks':[]}
        body = {'goal':'UTC', 'conversation':history, 'installation_context':context}
        self.assertEqual(self.request(path='/api/plan', body=json.dumps(body))[0], 200)
        self.plan.assert_called_once_with('UTC', '', history, context)
        history[0]['role'] = 'system'
        self.assertEqual(self.request(path='/api/plan', body=json.dumps(body))[0], 400)


if __name__ == '__main__':
    unittest.main()
