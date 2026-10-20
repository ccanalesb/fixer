"""Unit tests for ``ollama_autopilot`` cycle decisions (stdlib only)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ollama_autopilot import (  # noqa: E402
    CULL_TYPE,
    KIMI_TYPES,
    REDECIDE_TYPE,
    WINDOW_5H_S,
    decide_launch,
    rolling_seconds,
)


class DecideLaunchTests(unittest.TestCase):
    def test_under_budget_launches_cull_before_describe(self) -> None:
        ledger = {"rr": 0, "backoff": {}, "jobs": {}}
        d = decide_launch(ledger, now=1000.0, over_budget=False, running=None)
        self.assertEqual(d["action"], "create")
        self.assertEqual(d["job_type"], CULL_TYPE)
        self.assertEqual(d["metadata"]["scope_job_type"], "batch_describe")

    def test_after_cull_done_launches_describe(self) -> None:
        ledger = {"rr": 0, "backoff": {}, "cull_done_for": "batch_describe", "jobs": {}}
        d = decide_launch(ledger, now=1000.0, over_budget=False, running=None)
        self.assertEqual(d["action"], "create")
        self.assertEqual(d["job_type"], "batch_describe")

    def test_over_budget_no_create(self) -> None:
        d = decide_launch({}, now=0.0, over_budget=True, running=None)
        self.assertEqual(d["action"], "hold")

    def test_over_budget_cull_running_not_cancelled(self) -> None:
        running = {"id": "j1", "type": CULL_TYPE, "progress": 10}
        d = decide_launch({}, now=0.0, over_budget=True, running=running)
        self.assertEqual(d["action"], "hold")

    def test_over_budget_describe_cancelled(self) -> None:
        running = {"id": "j1", "type": "batch_describe", "progress": 10}
        d = decide_launch({}, now=0.0, over_budget=True, running=running)
        self.assertEqual(d["action"], "cancel")
        self.assertEqual(d["job_id"], "j1")

    def test_cull_in_flight_holds(self) -> None:
        running = {"id": "j1", "type": CULL_TYPE, "progress": 5}
        d = decide_launch({}, now=0.0, over_budget=False, running=running)
        self.assertEqual(d["action"], "hold")

    def test_cull_backoff_holds(self) -> None:
        ledger = {"rr": 0, "backoff": {CULL_TYPE: 2000.0}, "jobs": {}}
        d = decide_launch(ledger, now=1000.0, over_budget=False, running=None)
        self.assertEqual(d["reason"], "cull_backoff")


class RollingSecondsTests(unittest.TestCase):
    def test_completed_cull_counts_zero(self) -> None:
        now = 10_000.0
        ledger = {
            "jobs": {
                "a": {
                    "type": CULL_TYPE,
                    "started_ts": now - 600,
                    "completed_ts": now - 60,
                }
            }
        }
        self.assertEqual(rolling_seconds(ledger, WINDOW_5H_S, now), 0.0)

    def test_completed_describe_uses_kimi_tail(self) -> None:
        now = 10_000.0
        completed = now - 100
        ledger = {
            "jobs": {
                "a": {
                    "type": "batch_describe",
                    "started_ts": completed - 900,
                    "completed_ts": completed,
                    "kimi_s": 300,
                }
            }
        }
        self.assertAlmostEqual(rolling_seconds(ledger, WINDOW_5H_S, now), 300.0, places=3)


if __name__ == "__main__":
    unittest.main()
