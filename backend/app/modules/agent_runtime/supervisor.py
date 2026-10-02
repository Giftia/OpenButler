"""Stoppable, event/deadline-driven host for the local-only runtime.

This is deliberately not an OS scheduler. A sleeping process cannot run work,
and nothing here enables the runtime, a collector, or a model provider.
"""

from __future__ import annotations

from datetime import datetime, timezone
from threading import Event, Lock, Thread
from typing import Callable


class RuntimeSupervisor:
    def __init__(self, service, *, clock: Callable[[], datetime] | None = None,
                 max_wakes: int = 4, min_interval: float = 1.0,
                 error_backoff: float = 30.0):
        if not 1 <= max_wakes <= 20:
            raise ValueError("invalid_runtime_work_budget")
        if min_interval < 0.05 or error_backoff < min_interval:
            raise ValueError("invalid_runtime_wait_budget")
        self.service = service
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.max_wakes = max_wakes
        self.min_interval = min_interval
        self.error_backoff = error_backoff
        self._wake = Event()
        self._stop = Event()
        self._lifecycle = Lock()
        self._thread: Thread | None = None

    def start(self) -> None:
        """Start once; persisted user enablement is checked before every batch."""
        with self._lifecycle:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._wake.set()  # Reconcile persisted deadlines/recoverable leases.
            self._thread = Thread(target=self._loop, name="openbutler-local-runtime", daemon=True)
            self._thread.start()

    def kick(self) -> None:
        """Coalesce API events without allocating one task per event."""
        self._wake.set()

    def stop(self, timeout: float = 5.0) -> bool:
        """Stop further batches and wait for the bounded current batch."""
        with self._lifecycle:
            self._stop.set()
            self._wake.set()
            thread = self._thread
            if thread is not None:
                thread.join(timeout=max(0.0, timeout))
            stopped = thread is None or not thread.is_alive()
            if stopped:
                self._thread = None
            return stopped

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _due_at(self, status: dict) -> datetime | None:
        if not status.get("enabled") or not status.get("next_wake_at"):
            return None
        due = status["next_wake_at"]
        if isinstance(due, str):
            due = datetime.fromisoformat(due.replace("Z", "+00:00"))
        if not isinstance(due, datetime) or due.tzinfo is None:
            raise ValueError("invalid_runtime_deadline")
        return due

    def _delay(self, status: dict) -> float | None:
        due = self._due_at(status)
        if due is None:
            return None
        now = self.clock()
        if now.tzinfo is None:
            raise ValueError("invalid_runtime_clock")
        # Even a malformed/stuck deadline cannot turn into a busy loop.
        return max(self.min_interval, (due - now).total_seconds())

    def _loop(self) -> None:
        delay: float | None = None
        while not self._stop.is_set():
            self._wake.wait(delay)
            # Clearing before reading durable state prevents lost event writes:
            # later writes set the event again for the subsequent iteration.
            self._wake.clear()
            if self._stop.is_set():
                break
            try:
                status = self.service.status()
                due = self._due_at(status)
                if due is not None and due <= self.clock():
                    if self._stop.is_set():
                        break
                    self.service.run_once(max_wakes=self.max_wakes)
                delay = self._delay(self.service.status())
            except Exception:
                # No exception text (which may contain local paths/content) is
                # logged or exposed. A bounded backoff allows local recovery.
                delay = self.error_backoff
