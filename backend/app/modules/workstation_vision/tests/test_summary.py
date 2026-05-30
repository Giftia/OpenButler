from __future__ import annotations

import unittest

from app.modules.workstation_vision.timeline.summaries import build_summary


class SummaryTests(unittest.TestCase):
    def test_today_summary_aggregates_presence_and_breaks(self) -> None:
        events = [
            {
                "type": "presence_state",
                "state": "present",
                "duration_seconds": 3600,
                "confidence": 0.92,
                "started_at": "2026-05-29T09:00:00+00:00",
                "ended_at": "2026-05-29T10:00:00+00:00",
                "reason_codes": [],
                "metrics": {},
            },
            {
                "type": "presence_state",
                "state": "away",
                "duration_seconds": 600,
                "confidence": 0.88,
                "started_at": "2026-05-29T10:00:00+00:00",
                "ended_at": "2026-05-29T10:10:00+00:00",
                "reason_codes": [],
                "metrics": {},
            },
            {
                "type": "fatigue_signal",
                "state": "medium",
                "duration_seconds": 60,
                "confidence": 0.66,
                "started_at": "2026-05-29T10:20:00+00:00",
                "reason_codes": ["long_session"],
                "metrics": {},
            },
        ]
        summary = build_summary(events)
        self.assertEqual(summary["metrics"]["total_present_minutes"], 60)
        self.assertEqual(summary["metrics"]["total_away_minutes"], 10)
        self.assertEqual(summary["metrics"]["break_count"], 1)
        self.assertEqual(summary["metrics"]["fatigue_signal_count"], 1)


if __name__ == "__main__":
    unittest.main()

