"""No network, model calls, user activity, or OS scheduling."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock
import tempfile
import time
import unittest

from app.modules.agent_runtime.supervisor import RuntimeSupervisor
from app.modules.agent_runtime.service import RuntimeService


class FakeRuntime:
    def __init__(self, enabled=False, deadline=None):
        self.enabled = enabled
        self.deadline = deadline
        self.calls = []
        self.status_calls = 0
        self.processed = Event()
        self.lock = Lock()

    def status(self):
        with self.lock:
            self.status_calls += 1
            return {"enabled": self.enabled, "next_wake_at": self.deadline}

    def run_once(self, max_wakes):
        with self.lock:
            self.calls.append(max_wakes)
            self.deadline = None
            self.processed.set()


class RuntimeSupervisorTests(unittest.TestCase):
    def test_disabled_and_idle_do_not_poll_or_run(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                service = FakeRuntime(enabled=enabled)
                worker = RuntimeSupervisor(service)
                worker.start()
                try:
                    time.sleep(0.08)
                    reads = service.status_calls
                    time.sleep(0.08)
                    self.assertEqual(service.status_calls, reads)
                    self.assertEqual(service.calls, [])
                finally:
                    self.assertTrue(worker.stop())

    def test_event_kick_observes_new_work_and_enforces_batch_budget(self):
        service = FakeRuntime()
        worker = RuntimeSupervisor(service, max_wakes=3)
        worker.start()
        try:
            with service.lock:
                service.enabled = True
                service.deadline = datetime.now(timezone.utc).isoformat()
            worker.kick()
            self.assertTrue(service.processed.wait(1))
            self.assertEqual(service.calls, [3])
        finally:
            self.assertTrue(worker.stop())

    def test_future_deadline_wakes_without_event_and_no_early_run(self):
        due = datetime.now(timezone.utc) + timedelta(seconds=0.15)
        service = FakeRuntime(enabled=True, deadline=due.isoformat())
        worker = RuntimeSupervisor(service, min_interval=0.05)
        worker.start()
        try:
            self.assertFalse(service.processed.wait(0.05))
            self.assertTrue(service.processed.wait(1))
            self.assertEqual(service.calls, [4])
        finally:
            self.assertTrue(worker.stop())

    def test_disabling_before_deadline_prevents_work(self):
        due = datetime.now(timezone.utc) + timedelta(seconds=0.15)
        service = FakeRuntime(enabled=True, deadline=due.isoformat())
        worker = RuntimeSupervisor(service, min_interval=0.05)
        worker.start()
        try:
            with service.lock:
                service.enabled = False
            worker.kick()
            self.assertFalse(service.processed.wait(0.25))
            self.assertEqual(service.calls, [])
        finally:
            self.assertTrue(worker.stop())

    def test_shutdown_interrupts_indefinite_sleep_and_is_restartable(self):
        service = FakeRuntime()
        worker = RuntimeSupervisor(service)
        worker.start()
        first = worker._thread
        worker.start()
        self.assertIs(worker._thread, first)
        self.assertTrue(worker.stop(timeout=1))
        self.assertFalse(worker.running)
        worker.start()
        self.assertTrue(worker.running)
        self.assertTrue(worker.stop(timeout=1))

    def test_error_is_backed_off_without_exception_content(self):
        class BrokenRuntime(FakeRuntime):
            def status(self):
                self.status_calls += 1
                raise ValueError("sensitive-local-path")
        service = BrokenRuntime()
        worker = RuntimeSupervisor(service, min_interval=0.05, error_backoff=0.25)
        worker.start()
        try:
            time.sleep(0.1)
            self.assertEqual(service.status_calls, 1)
        finally:
            self.assertTrue(worker.stop())

    def test_real_consent_deadline_runs_maintenance_without_planning(self):
        class DeadlineRuntime(RuntimeService):
            maintained = Event()

            def status(self):
                result = super().status()
                with self.store.read() as conn:
                    if conn.execute("SELECT count(*) FROM sources WHERE status='expired'").fetchone()[0]:
                        self.maintained.set()
                return result

        with tempfile.TemporaryDirectory(prefix="openbutler-deadline-") as directory:
            service = DeadlineRuntime(Path(directory) / "synthetic.sqlite3")
            service.grant_source("synthetic", expires_at=datetime.now(timezone.utc) + timedelta(seconds=0.2))
            service.set_enabled(True)
            worker = RuntimeSupervisor(service, min_interval=0.05)
            worker.start()
            try:
                self.assertTrue(service.maintained.wait(2), "Consent expiry must wake an otherwise idle runtime")
                self.assertEqual(service.list_runs(), [], "Maintenance-only deadline must not create a work run")
            finally:
                self.assertTrue(worker.stop())


if __name__ == "__main__":
    unittest.main()
