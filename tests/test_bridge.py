import json
import os
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from linuxlink import Framer, Runner, encode, environment


class FramingTests(unittest.TestCase):
    def test_default_mode_tracks_live_or_installed_environment(self):
        with patch('linuxlink.Path.exists', return_value=True):
            self.assertEqual(environment()['default_mode'],'install')
        with patch('linuxlink.Path.exists', return_value=False):
            self.assertEqual(environment()['default_mode'],'troubleshoot')
            self.assertFalse(environment()['live'])

    def test_fragmented_unicode_and_multiple_frames(self):
        data = encode({"id": "1", "op": "exec", "command": "echo café"}) + encode({"id": "2", "op": "ping"})
        framer, found = Framer(), []
        for byte in data:
            found.extend(framer.feed(bytes([byte])))
        self.assertEqual([x["id"] for x in found], ["1", "2"])
        self.assertEqual(found[0]["command"], "echo café")

    def test_overflow_recovers_on_next_frame(self):
        results = list(Framer().feed(b"x" * 3000 + b'\n{"id":"ok","op":"ping"}\n'))
        self.assertEqual(results[0]["reason"], "Frame too large")
        self.assertEqual(results[1]["id"], "ok")

    def test_invalid_json_and_non_objects(self):
        results = list(Framer().feed(b'bad\n[]\nnull\n'))
        self.assertTrue(all(x["op"] == "invalid" for x in results))


@unittest.skipUnless(sys.platform == "linux", "Requires Linux subprocess groups and selectors")
class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.messages = []
        self.runner = Runner(self.messages.append)

    def tearDown(self):
        self.runner.close()

    def wait_done(self):
        self.runner.thread.join(8)
        self.assertFalse(self.runner.thread.is_alive())

    def test_stdout_stderr_and_exit(self):
        self.runner.handle({"id": "1", "op": "exec", "command": "printf hello; printf problem >&2; exit 7"})
        self.wait_done()
        self.assertEqual("".join(m.get("data", "") for m in self.messages if m["type"] == "stdout"), "hello")
        self.assertEqual("".join(m.get("data", "") for m in self.messages if m["type"] == "stderr"), "problem")
        self.assertEqual(self.messages[-1]["code"], 7)

    def test_timeout_kills_process_group(self):
        self.runner.handle({"id": "1", "op": "exec", "command": "sleep 30 & wait", "timeout": 1})
        self.wait_done()
        self.assertEqual(self.messages[-1]["reason"], "timeout")

    def test_cancel_and_busy(self):
        self.runner.handle({"id": "1", "op": "exec", "command": "sleep 30"})
        self.runner.handle({"id": "2", "op": "exec", "command": "echo should-not-run"})
        self.runner.handle({"id": "3", "op": "cancel", "target": "wrong"})
        self.assertFalse(self.runner.stop.is_set())
        self.runner.handle({"id": "4", "op": "cancel", "target": "1"})
        self.wait_done()
        self.assertTrue(any(m.get("id") == "2" and m["type"] == "error" for m in self.messages))
        self.assertEqual(self.messages[-1]["reason"], "cancelled")

    def test_duplicate_not_executed(self):
        request = {"id": "same", "op": "exec", "command": "true"}
        self.runner.handle(request)
        self.wait_done()
        self.runner.handle(request)
        self.assertEqual(self.messages[-1]["type"], "error")
        self.assertIn("Duplicate", self.messages[-1]["message"])

    def test_output_is_bounded(self):
        self.runner.handle({"id": "1", "op": "exec", "command": "yes x", "timeout": 5})
        self.wait_done()
        self.assertEqual(self.messages[-1]["reason"], "output_limit")
        self.assertLessEqual(sum(len(m.get("data", "").encode()) for m in self.messages), 128 * 1024)


if __name__ == "__main__":
    unittest.main()
