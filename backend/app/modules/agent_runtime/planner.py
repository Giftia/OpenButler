"""Offline deterministic planner. No model, network, sensor or scheduler calls."""
from .models import ActionSpec, PlannerDecision
from .store import encode


class DeterministicPlanner:
    name = "deterministic-local-v1"

    def decide(self, goal, evidence, now):
        # The engine rechecks these IDs and predicates in its write transaction.
        matching = [item for item in evidence if (
            item["target_id"] == goal["target_id"]
            and item["event_type"] == goal["success_event_type"]
            and encode(item["value"]) == encode(goal["success_value"])
            and item["observed_at"] > goal["activated_at"]
        )]
        if matching and goal["status"] == "waiting_external":
            match = sorted(matching, key=lambda item: (item["observed_at"], item["id"]))[0]
            return PlannerDecision("complete", (match["id"],), (
                ActionSpec("inbox_notice", "completion", "Fresh matching authorized evidence verified the goal."),
            ))
        actions = []
        if goal["status"] == "active":
            actions.extend((
                ActionSpec("prepare_plan", "prepare", "Prepare the approved local plan."),
                ActionSpec("inbox_notice", "started", "The goal is active and waiting for matching evidence."),
            ))
        if goal.get("deadline_at") and now >= goal["deadline_at"]:
            actions.append(ActionSpec("ask_user", "deadline", "The deadline passed without verified completion. Review, change, or cancel this goal."))
        return PlannerDecision("wait", actions=tuple(actions))
