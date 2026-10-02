"""Bounded in-memory dispatch, with durable owned evidence and honest backlog state.

Only IDs and consent-generation tickets wait in memory. A single lazy worker
loads one owned image at a time. Nothing scans/resumes persisted work on startup;
backpressured, interrupted and failed records require an explicit retry.
"""
from collections import deque
from datetime import datetime
from threading import Condition, Thread

from .processor import failure_reason


class ObservationQueue:
    def __init__(self, captures, processor, *, capacity=4):
        if type(capacity) is not int or not 1 <= capacity <= 16:
            raise ValueError("invalid_queue_capacity")
        self.captures, self.processor, self.capacity = captures, processor, capacity
        self._condition = Condition()
        self._pending = deque()
        self._running = None
        self._worker = None
        self._closed = False

    def _prune(self):
        valid = deque()
        for job in self._pending:
            if job[2].is_set():
                continue
            try:
                self.captures.processing_ticket(job[0], generation=job[1])
                valid.append(job)
            except Exception as error:
                try:
                    self.captures.set_result(job[0], state="model_unavailable",
                                             processing_reason=failure_reason(error))
                except ValueError:
                    pass
        self._pending = valid

    def submit(self, event_id, *, generation=None, retry=False):
        with self._condition:
            self._prune()
            if self._closed:
                return {"accepted": False, "reason": "queue_closed"}
            if (any(job[0] == event_id for job in self._pending)
                    or (self._running and self._running[0] == event_id)):
                return {"accepted": False, "reason": "already_queued"}
            try:
                ticket = self.captures.processing_ticket(event_id, generation=generation, retry=retry)
                if len(self._pending) >= self.capacity:
                    self.captures.mark_queued(event_id, ticket[0], reason="queue_full", retry=retry)
                    return {"accepted": False, "reason": "queue_full"}
                self.captures.mark_queued(event_id, ticket[0], retry=retry)
            except Exception as error:
                return {"accepted": False, "reason": failure_reason(error)}
            self._pending.append((event_id, *ticket))
            if self._worker is None:
                self._worker = Thread(target=self._run, name="context-observation-worker", daemon=True)
                self._worker.start()
            self._condition.notify_all()
            return {"accepted": True, "reason": "queued"}

    def state(self):
        with self._condition:
            self._prune()
            queued, running, closed = len(self._pending), int(self._running is not None), self._closed
        capture = self.captures.state()
        expiry = capture["provenance"].get("session_expires_at")
        session_valid = not expiry or datetime.fromisoformat(expiry.replace("Z", "+00:00")) > self.captures._clock()
        return {"capacity": self.capacity, "queued": queued, "running": running,
                "backpressured": self.captures.processing_counts().get("queue_full", 0),
                "accepting": bool(not closed and capture["active"] and capture["authorized"] and session_valid)}

    def _run(self):
        while True:
            with self._condition:
                self._prune()
                self._condition.wait_for(lambda: self._closed or self._pending)
                if self._closed:
                    return
                job = self._pending.popleft()
                self._running = job
            event_id, generation, cancellation = job
            try:
                if cancellation.is_set():
                    raise PermissionError("authorization_revoked")
                image = self.captures.begin_processing(event_id, generation)
                self.processor.process(event_id, image, expected_generation=generation,
                                       cancel_event=cancellation)
            except Exception as error:
                try:
                    self.captures.set_result(event_id, state="model_unavailable",
                                             processing_reason=failure_reason(error))
                except ValueError:
                    pass  # Deleted or already invalidated; never recreate a record.
            finally:
                with self._condition:
                    self._running = None
                    self._condition.notify_all()

    def close(self, *, timeout=2.0):
        # Invalidate first: queued and in-flight requests cannot publish during join.
        self.captures.pause()
        with self._condition:
            self._closed = True
            self._pending.clear()
            self._condition.notify_all()
            worker = self._worker
        if worker is not None:
            worker.join(timeout)
        return worker is None or not worker.is_alive()

    def wait_idle(self, timeout=3.0):
        """Bounded test/owner shutdown aid, never used to wait inside ingestion."""
        with self._condition:
            return self._condition.wait_for(lambda: not self._pending and self._running is None, timeout)
