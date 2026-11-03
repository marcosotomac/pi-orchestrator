"""PTY harness regressions: mocked clock/polling and one real Node fixture, no models."""
import importlib.util
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("tui_smoke", Path(__file__).resolve().parents[1] / "scripts/tui-smoke.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class ShutdownPollingTests(unittest.TestCase):
    def simulate(self, exit_at, timeout):
        elapsed = 0.0
        polls = 0

        def sleep(seconds):
            nonlocal elapsed
            self.assertGreater(seconds, 0, "EOF polling must yield, not busy-loop")
            elapsed += seconds

        def waitpid(pid, flags):
            nonlocal polls
            polls += 1
            return (pid, 0) if exit_at is not None and elapsed >= exit_at else (0, 0)

        with patch.object(harness.time, "monotonic", side_effect=lambda: elapsed), \
             patch.object(harness.time, "sleep", side_effect=sleep), \
             patch.object(harness.os, "waitpid", side_effect=waitpid):
            if exit_at is None:
                with self.assertRaisesRegex(AssertionError, "deadline"):
                    harness.wait_for_exit(123, lambda seconds: None, timeout)
            else:
                self.assertEqual(harness.wait_for_exit(123, lambda seconds: None, timeout), 0)
        return elapsed, polls

    def test_eof_before_exit_waits_for_observed_exit(self):
        elapsed, polls = self.simulate(exit_at=0.25, timeout=1)
        self.assertGreaterEqual(elapsed, 0.25)
        self.assertLess(elapsed, 0.30)
        self.assertLess(polls, 40)

    def test_eof_without_exit_still_respects_deadline(self):
        elapsed, polls = self.simulate(exit_at=None, timeout=0.10)
        self.assertGreaterEqual(elapsed, 0.10)
        self.assertLessEqual(elapsed, 0.11)
        self.assertLess(polls, 20)


class FixtureLifelineTests(unittest.TestCase):
    def test_worker_exits_itself_when_private_writer_closes(self):
        with tempfile.TemporaryDirectory(prefix="pi-orchestrator-lifeline-") as directory:
            fifo = Path(directory) / "lifeline"
            os.mkfifo(fifo, 0o600)
            writer = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
            worker = subprocess.Popen(["node", str(Path(__file__).parent / "fixtures/tui-worker.cjs"), str(fifo)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertTrue(select.select([worker.stdout], [], [], 3)[0], "fixture must initialize")
                self.assertEqual(worker.stdout.readline(), b"{}\n")
                self.assertIsNone(worker.poll(), "fixture must still be alive while its writer is open")
                os.close(writer)
                writer = None
                self.assertEqual(worker.wait(timeout=3), 0, "EOF must cause self-exit without sending a signal")
            finally:
                if writer is not None:
                    os.close(writer)
                if worker.poll() is None:
                    worker.kill()  # Only the live Popen child handle, never a saved PID.
                worker.communicate(timeout=3)


if __name__ == "__main__":
    unittest.main()
