import json
import unittest
from datetime import datetime, timezone

from pydantic import ValidationError

from app.modules.context_engine.foundation import (
    ContextEngineStatusService, EventEnvelope, SourceCapability,
)


class FoundationTests(unittest.TestCase):
    def event(self, **changes):
        values = dict(event_id="event-1", source_id="screen_capture",
                      source_event_id="source-1", observed_at=datetime.now(timezone.utc),
                      event_type="screen.observation")
        values.update(changes)
        return EventEnvelope(**values)

    def test_event_requires_aware_time_and_known_source(self):
        self.assertEqual(self.event().source_id, "screen_capture")
        for changes in ({"observed_at": datetime.now()}, {"event_id": ""},
                        {"source_id": "C:\\private\\screen.png"}, {"unknown": True}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.event(**changes)

    def test_payload_is_internal_not_repr_or_status(self):
        event = self.event(payload={"title": "PRIVATE_SENTINEL"})
        self.assertNotIn("PRIVATE_SENTINEL", repr(event))
        status = ContextEngineStatusService().get_redacted_status().model_dump(mode="json")
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(status))
        self.assertEqual(set(status), {"state", "capabilities", "evidence_boundary"})

    def test_defaults_do_not_authorize_source_access(self):
        cap = SourceCapability(source_id="screen_capture")
        self.assertFalse(cap.enabled)
        self.assertEqual(cap.access_mode, "read_only")
        self.assertFalse(cap.supports_backfill)
        self.assertFalse(cap.supports_live_observations)

    def test_status_cannot_accept_configuration_or_free_form_state(self):
        from app.modules.context_engine.foundation import ContextEngineStatus
        for changes in ({"api_key": "PRIVATE_SENTINEL"}, {"state": "PRIVATE_SENTINEL"}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                ContextEngineStatus(**changes)
        with self.assertRaises(ValidationError):
            SourceCapability(source_id="manual", local_path="PRIVATE_SENTINEL")
        with self.assertRaises(ValidationError):
            ContextEngineStatusService([self.event(payload={"secret": "PRIVATE_SENTINEL"})]).get_redacted_status()

    def test_status_has_only_registered_capability_metadata(self):
        status = ContextEngineStatusService([SourceCapability(source_id="manual")])
        value = status.get_redacted_status().model_dump(mode="json")
        self.assertEqual(value["state"], "foundation_only")
        self.assertEqual(value["capabilities"][0]["source_id"], "manual")
        with self.assertRaises(ValidationError):
            SourceCapability(source_id="manual", access_mode="write")


if __name__ == "__main__":
    unittest.main()
