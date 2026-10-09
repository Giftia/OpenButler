"""Native user-work contracts, using only isolated synthetic evidence and clocks."""

from datetime import timedelta
import json
from pathlib import Path
import shutil
from threading import Event
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from pydantic import ValidationError

from app.modules.context_engine.processor import ObservationProcessor
from app.modules.context_engine.capture import init_capture_store
from app.modules.context_engine.organization_queue import ObservationQueue
from app.modules.task_activity import models
from app.modules.task_activity.discovery import Proposal
from app.modules.task_activity.service import TaskError, TaskService
from app.modules.task_activity.tests.fixture import TaskFixture, synthetic_commit_guard


class TaskTests(TaskFixture, unittest.TestCase):
    def assert_error(self, code, operation, *args, **kwargs):
        with self.assertRaises(TaskError) as raised:
            operation(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_manual_task_create_edit_complete_reopen_archive(self):
        due = self.now + timedelta(days=2)
        task = self.task("  Review public documentation  ", description="Synthetic notes", priority="high", due_at=due)
        self.assertEqual((task["title"], task["status"], task["priority"]),
                         ("Review public documentation", "todo", "high"))
        self.assertEqual(task["due_at"], due.isoformat())
        self.assertTrue(task["confirmed"])
        self.assertEqual(task["created_by"], "user")
        task = self.edit(task, priority="urgent", status="doing", due_at=None)
        self.assertEqual((task["priority"], task["status"], task["due_at"]), ("urgent", "doing", None))
        task = self.edit(task, status="done")
        self.assertEqual(task["completed_at"], self.now.isoformat())
        task = self.edit(task, status="todo")
        self.assertIsNone(task["completed_at"])
        task = self.edit(task, archived=True)
        self.assertEqual(self.service.list_tasks()["items"], [])
        self.assertEqual(self.service.list_tasks(True)["items"][0]["id"], task["id"])
        self.edit(task, archived=False, title="Renamed user work", description="Owned text")
        self.assertEqual(self.service.list_tasks()["items"][0]["title"], "Renamed user work")

    def test_commands_are_uuid_idempotent_and_content_bound(self):
        command = uuid4()
        request = models.TaskCreate(command_id=command, title="Synthetic command")
        first = self.service.create_task(request)
        self.assertEqual(self.service.create_task(request), first)
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)
        self.assert_error("command_conflict", self.service.create_task,
                          models.TaskCreate(command_id=command, title="Changed intent"))
        self.assert_error("command_conflict", self.service.create_activity,
            models.ActivityCreate(command_id=command, title="Different command kind",
                                  start_at=self.now, end_at=self.now))
        with self.assertRaises(ValidationError):
            models.TaskCreate(command_id="not-a-uuid", title="Bad command")

    def test_activity_command_replay_and_optimistic_task_edit_conflict(self):
        request = models.ActivityCreate(command_id=uuid4(), title="Zero-time manual note",
                                        start_at=self.now, end_at=self.now)
        activity = self.service.create_activity(request)
        self.assertEqual(self.service.create_activity(request), activity)
        self.assertEqual(len(self.service.list_activities()["items"]), 1)
        task = self.task()
        self.edit(task, title="First edit wins")
        error = self.assert_error("version_conflict", self.service.edit_task, task["id"],
            models.TaskEdit(expected_version=task["version"], title="Stale edit"))
        self.assertEqual(error.status, 409)
        self.assertEqual(self.current(task)["title"], "First edit wins")

    def test_contract_rejects_implicit_completion_or_source_ownership_fields(self):
        for extra in ({"status": "done"}, {"created_by": "assistant"}, {"origin_activity_id": "activity_fake"}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                models.TaskCreate(command_id=uuid4(), title="Public task", **extra)
        for fields in ({"expected_version": True}, {"expected_version": 1, "confirmed": False},
                       {"expected_version": 1, "status": None}, {"expected_version": 1, "title": "   "},
                       {"expected_version": 1, "priority": "critical"},
                       {"expected_version": 1, "due_at": self.now.replace(tzinfo=None)}):
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                models.TaskEdit(**fields)

    def test_intervals_require_aware_nonnegative_bounded_nonfuture_times(self):
        for start, end in ((self.now, self.now - timedelta(seconds=1)),
                           (self.now - timedelta(days=2), self.now),
                           (self.now.replace(tzinfo=None), self.now)):
            with self.subTest(start=start, end=end), self.assertRaises(ValidationError):
                models.ActivityCreate(command_id=uuid4(), title="Synthetic activity", start_at=start, end_at=end)
        self.assert_error("future_activity_not_allowed", self.service.create_activity,
            models.ActivityCreate(command_id=uuid4(), title="Future activity", start_at=self.now,
                                  end_at=self.now + timedelta(seconds=1)))

    def test_discovery_off_by_default_does_not_read_sources_or_enable_capture(self):
        settings = self.service.settings()
        self.assertFalse(settings["auto_discovery"])
        self.assertIsNone(settings["enabled_at"])
        before = self.sql("SELECT * FROM context_capture_settings")
        with patch.object(self.service, "_source", side_effect=AssertionError("Must not read sources")):
            self.assertEqual(self.service.sync(), {"processed": 0, "reason": "disabled"})
            self.assertEqual(self.service.process_observation(str(uuid4())), {"processed": False, "reason": "disabled"})
        self.assertEqual(self.sql("SELECT * FROM context_capture_settings"), before)
        self.assert_error("discovery_consent_required", self.service.set_settings,
            models.SettingsEdit(expected_version=1, auto_discovery=True, confirmed=False))
        self.enable()
        self.assertEqual(self.sql("SELECT * FROM context_capture_settings"), before)

    def test_exact_marker_creates_unconfirmed_task_without_priority_deadline_or_done_inference(self):
        self.enable()
        source = self.source("TODO(me): Review public guide due tomorrow urgent done")
        # The fixture itself passes the same production source-grounding validator.
        ground = dict(source, provenance=json.loads(source["provenance"]),
                      current_facts=json.loads(source["current_facts"]), observation_mode="masked_ocr_text")
        self.assertTrue(ObservationProcessor.grounded_prior(ground))
        activity = self.process(source)
        task = self.service.list_tasks()["items"][0]
        self.assertEqual(task["title"], "Review public guide due tomorrow urgent done")
        self.assertEqual((task["created_by"], task["confirmed"], task["priority"], task["status"]),
                         ("assistant", False, "normal", "todo"))
        self.assertIsNone(task["due_at"])
        self.assertIsNone(task["completed_at"])
        self.assertEqual((activity["start_at"], activity["end_at"], activity["time_kind"]),
                         (source["captured_at"], source["captured_at"], "sample"))
        detail = self.service.detail(task["id"])
        self.assertEqual(detail["time"]["total_seconds"], 0)
        self.assertFalse(detail["activities"][0]["link"]["primary"])
        self.assertEqual(detail["activities"][0]["link"]["relation"], "possible")
        self.assertEqual(detail["resources"][0]["reference"], source["evidence_id"])

    def test_ambiguous_discoveries_require_accept_and_dismiss_stays_suppressed(self):
        self.enable()
        self.process(self.source("TODO: Review public appendix\n- [ ] Write public example"))
        self.assertEqual(self.service.list_tasks()["items"], [])
        candidates = {d["title"]: d for d in self.service.discoveries()["items"]}
        accepted = candidates["Review public appendix"]
        task = self.service.resolve(accepted["id"], models.DiscoveryResolution(
            expected_version=accepted["version"], decision="accept"))["task"]
        self.assertTrue(task["confirmed"])
        self.assertEqual(task["status"], "todo")
        dismissed = candidates["Write public example"]
        self.assertIsNone(self.service.resolve(dismissed["id"], models.DiscoveryResolution(
            expected_version=dismissed["version"], decision="dismiss"))["task"])
        self.assert_error("version_conflict", self.service.resolve, accepted["id"],
            models.DiscoveryResolution(expected_version=accepted["version"], decision="accept"))
        self.process(self.source("TODO(me): Write public example"))
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)
        self.assertEqual([d["state"] for d in self.service.discoveries()["items"]
                          if d["title"] == "Write public example"], ["dismissed", "dismissed"])

    def test_repeated_sync_and_exact_normalized_titles_dedupe_but_not_topics(self):
        self.enable()
        self.process(self.source("TODO(me): Review Public API"))
        self.process(self.source("TODO(me): review   public api"))
        self.process(self.source("TODO(me): Review public API examples"))
        before = self.service.list_tasks()["items"]
        self.assertEqual(len(before), 2)
        self.service.sync()
        self.service.sync()
        self.assertEqual(self.service.list_tasks()["items"], before)
        self.assertEqual(len(self.service.list_activities()["items"]), 3)
        self.assertEqual(len(self.service.discoveries()["items"]), 3)

    def test_multiple_exact_manual_tasks_remain_ambiguous(self):
        self.task("Review duplicate")
        self.task("Review duplicate")
        self.enable()
        self.process(self.source("TODO(me): Review duplicate"))
        self.assertEqual(len(self.service.list_tasks()["items"]), 2)
        self.assertEqual(self.service.discoveries()["items"][0]["state"], "pending")
        self.assertEqual(self.sql("SELECT * FROM work_task_links"), [])

    def test_assistant_cannot_complete_or_reprioritize_user_task(self):
        task = self.task("Ship public example", priority="high", due_at=self.now + timedelta(days=2))
        original = dict(task)
        self.enable()
        self.process(self.source("TODO(me): Ship public example"))
        self.process(self.source("Done: Ship public example"))
        task = self.current(task)
        for key in ("title", "priority", "due_at", "status", "completed_at"):
            self.assertEqual(task[key], original[key])
        self.edit(task, status="done")
        self.process(self.source("TODO(me): Ship public example"))
        self.assertEqual(self.current(task)["status"], "done")
        self.assertEqual(len(self.service.detail(task["id"])["activities"]), 1)

    def test_untrusted_ungrounded_source_is_not_task_evidence(self):
        self.enable()
        self.process(self.source("TODO(me): Unsupported task", grounded=False))
        self.assertEqual(self.service.list_tasks()["items"], [])
        self.assertEqual(self.service.discoveries()["items"], [])

    def test_unauthorized_expired_future_historical_and_missing_evidence_sources_rejected(self):
        self.enable()
        cases = ({"source_kind": "full_screen"}, {"consent_revision": str(uuid4())},
                 {"state": "processing"}, {"expires_at": self.now},
                 {"captured_at": self.now + timedelta(seconds=1)},
                 {"captured_at": self.now - timedelta(seconds=1)}, {"media": False})
        for fields in cases:
            with self.subTest(fields=fields):
                source = self.source(**fields)
                self.assertEqual(self.service.process_observation(source["id"]),
                                 {"processed": False, "reason": "source_outside_scope"})
        self.assertEqual(self.service.list_activities()["items"], [])
        self.assertEqual(self.service.list_tasks()["items"], [])

    def test_nonregular_empty_and_noncanonical_evidence_files_rejected(self):
        self.enable()
        for kind in ("empty", "directory", "symlink", "noncanonical"):
            with self.subTest(kind=kind):
                source = self.source()
                path = self.root / "context_engine" / "media" / (source["evidence_id"] + ".png")
                path.unlink()
                if kind == "empty":
                    path.touch()
                elif kind == "directory":
                    path.mkdir()
                elif kind == "symlink":
                    target = self.root / "synthetic.bin"
                    target.write_bytes(b"synthetic")
                    path.symlink_to(target)
                else:
                    self.sql("UPDATE context_observations SET evidence_id=? WHERE id=?",
                             ("../noncanonical", source["id"]))
                self.assertFalse(self.service.process_observation(source["id"])["processed"])

    def test_activity_many_to_many_and_user_correction_survives_sync_and_restart(self):
        self.enable()
        source = self.source()
        activity = self.process(source)
        task = self.service.list_tasks()["items"][0]
        other = self.task("Public related work")
        self.link(other, activity, relation="reference", primary=False)
        self.link(task, activity, relation="possible", decision="rejected", primary=False)
        self.service.sync()
        self.service = TaskService(self.path, clock=lambda: self.now)
        self.service.sync()
        corrected = self.service.detail(task["id"])["activities"][0]["link"]
        self.assertEqual((corrected["decision"], corrected["origin"]), ("rejected", "user"))
        self.assertEqual(self.service.detail(other["id"])["activities"][0]["link"]["relation"], "reference")
        self.assertEqual(len(self.service.list_activities()["items"]), 1)

    def test_same_topic_is_possible_only_and_does_not_override_manual_rejection(self):
        self.enable()
        prior = self.source("TODO(me): Review public example")
        self.process(prior)
        task = self.service.list_tasks()["items"][0]
        context = {"relations": [{"relation": "same_topic", "prior_observation_id": prior["id"],
                    "current_quote": "Public example reference", "prior_quote": "TODO(me): Review public example"}]}
        current = self.source("Public example reference", temporal_context=context)
        activity = self.process(current)
        detail = self.service.detail(task["id"])
        self.assertEqual(len(detail["activities"]), 2)
        self.assertTrue(all(a["link"]["relation"] == "possible" for a in detail["activities"]))
        self.assertEqual(detail["time"]["total_seconds"], 0)
        self.link(task, activity, relation="possible", decision="rejected", primary=False)
        self.service.sync()
        link = next(a["link"] for a in self.service.detail(task["id"])["activities"] if a["id"] == activity["id"])
        self.assertEqual((link["decision"], link["origin"]), ("rejected", "user"))

    def test_sample_gaps_only_expand_observed_span_never_work_duration(self):
        self.enable()
        self.process(self.source())
        task = self.service.list_tasks()["items"][0]
        self.now += timedelta(hours=3)
        later = self.process(self.source())
        self.link(task, later)
        time = self.service.detail(task["id"])["time"]
        self.assertEqual(time["observed_span_seconds"], 10800)
        self.assertEqual((time["manual_seconds"], time["estimated_seconds"], time["total_seconds"]), (0, 0, 0))

    def test_primary_attribution_is_unique_and_old_owner_version_invalidates(self):
        first, second = self.task("First"), self.task("Second")
        activity = self.activity()
        first = self.link(first, activity)
        second = self.link(second, activity)
        self.assertEqual(self.service.detail(first["id"])["time"]["total_seconds"], 0)
        self.assertEqual(self.service.detail(second["id"])["time"]["total_seconds"], 1800)
        self.assertGreater(self.current(first)["version"], first["version"])
        self.assertFalse(self.service.detail(first["id"])["activities"][0]["link"]["primary"])
        with self.assertRaises(ValidationError):
            models.LinkEdit(expected_version=1, relation="reference", decision="accepted", primary=True)
        with self.assertRaises(ValidationError):
            models.LinkEdit(expected_version=1, relation="work", decision="rejected", primary=True)

    def test_global_union_overlaps_and_manual_priority_over_estimates(self):
        estimated_task, manual_task = self.task("Estimated work"), self.task("Manual work")
        estimate = self.activity(-60, 0, "Synthetic estimated interval")
        # An internal historical estimate fixture, not a user API that turns samples into durations.
        self.sql("UPDATE work_activities SET time_kind='estimated',created_at=? WHERE id=?",
                 ((self.now - timedelta(hours=2)).isoformat(), estimate["id"]))
        manual = self.activity(-45, -15)
        overlap = self.activity(-30, 0, "Overlapping manual entry")
        self.link(estimated_task, estimate)
        self.link(manual_task, manual)
        self.link(manual_task, overlap)
        estimate_time = self.service.detail(estimated_task["id"])["time"]
        manual_time = self.service.detail(manual_task["id"])["time"]
        self.assertEqual(estimate_time["estimated_seconds"], 900)
        self.assertEqual(manual_time["manual_seconds"], 2700)
        self.assertEqual(estimate_time["total_seconds"] + manual_time["total_seconds"], 3600)

    def test_equal_kind_overlap_earlier_entry_wins_globally(self):
        first, second = self.task("First owner"), self.task("Second owner")
        early, late = self.activity(-60, -20), self.activity(-40, 0)
        self.sql("UPDATE work_activities SET created_at=? WHERE id=?",
                 ((self.now - timedelta(seconds=1)).isoformat(), early["id"]))
        self.link(first, early)
        self.link(second, late)
        self.assertEqual(self.service.detail(first["id"])["time"]["total_seconds"], 2400)
        self.assertEqual(self.service.detail(second["id"])["time"]["total_seconds"], 1200)

    def test_merge_and_unmerge_preserve_links_and_global_time(self):
        source, target = self.task("Source task"), self.task("Target task")
        first, second = self.activity(-60, -20), self.activity(-40, 0)
        self.link(source, first)
        self.link(target, second)
        before_links = self.sql("SELECT * FROM work_task_links ORDER BY task_id,activity_id")
        merged = self.service.merge(source["id"], models.MergeRequest(
            expected_version=self.current(source)["version"], target_id=target["id"],
            target_version=self.current(target)["version"]))
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)
        detail = self.service.detail(target["id"])
        self.assertEqual(detail["time"]["total_seconds"], 3600)
        self.assertEqual(len(detail["activities"]), 2)
        self.assertEqual(detail["merged_tasks"][0]["id"], source["id"])
        self.assertEqual(self.service.detail(source["id"])["time"]["total_seconds"], 0)
        self.assert_error("task_is_merged", self.service.edit_task, source["id"],
                          models.TaskEdit(expected_version=merged["version"], title="Hidden edit"))
        self.service.unmerge(source["id"], models.Versioned(expected_version=merged["version"]))
        self.assertEqual(len(self.service.list_tasks()["items"]), 2)
        self.assertEqual(self.sql("SELECT * FROM work_task_links ORDER BY task_id,activity_id"), before_links)
        self.assertEqual(sum(self.service.detail(t["id"])["time"]["total_seconds"] for t in (source, target)), 3600)

    def test_merge_shared_activity_shown_once_and_unmerge_reversible(self):
        source, target = self.task("Source"), self.task("Target")
        activity = self.activity()
        self.link(source, activity)
        self.link(target, activity, relation="reference", primary=False)
        merged = self.service.merge(source["id"], models.MergeRequest(
            expected_version=self.current(source)["version"], target_id=target["id"],
            target_version=self.current(target)["version"]))
        self.assertEqual(len(self.service.detail(target["id"])["activities"]), 1)
        self.assertEqual(self.service.detail(target["id"])["time"]["total_seconds"], 0)
        self.service.unmerge(source["id"], models.Versioned(expected_version=merged["version"]))
        self.assertEqual(self.service.detail(source["id"])["activities"][0]["link"]["relation"], "work")
        self.assertEqual(self.service.detail(target["id"])["activities"][0]["link"]["relation"], "reference")

    def test_merged_user_rejection_excludes_time_and_unmerge_restores_original(self):
        source, target = self.task("Source work"), self.task("Target work")
        activity = self.activity()
        self.link(source, activity)
        self.link(target, activity, relation="possible", decision="rejected", primary=False)
        merged = self.service.merge(source["id"], models.MergeRequest(
            expected_version=self.current(source)["version"], target_id=target["id"],
            target_version=self.current(target)["version"]))
        detail = self.service.detail(target["id"])
        self.assertEqual(detail["activities"][0]["link"]["decision"], "rejected")
        self.assertEqual(detail["time"]["total_seconds"], 0)
        self.service.unmerge(source["id"], models.Versioned(expected_version=merged["version"]))
        self.assertEqual(self.service.detail(source["id"])["time"]["total_seconds"], 1800)
        self.assertEqual(self.service.detail(target["id"])["time"]["total_seconds"], 0)

    def test_merge_validates_both_versions_and_rejects_cycles(self):
        first, second = self.task("First"), self.task("Second")
        self.edit(second, description="Newer target")
        self.assert_error("version_conflict", self.service.merge, first["id"],
            models.MergeRequest(expected_version=first["version"], target_id=second["id"], target_version=second["version"]))
        self.assert_error("merge_conflict", self.service.merge, first["id"],
            models.MergeRequest(expected_version=first["version"], target_id=first["id"], target_version=first["version"]))
        self.service.merge(first["id"], models.MergeRequest(expected_version=first["version"],
            target_id=second["id"], target_version=self.current(second)["version"]))
        self.assert_error("merge_conflict", self.service.merge, second["id"],
            models.MergeRequest(expected_version=self.current(second)["version"],
                target_id=first["id"], target_version=self.current(first)["version"]))

    def test_resource_references_are_stored_without_file_or_network_io_and_replays_once(self):
        task = self.task()
        command = uuid4()
        request = models.ResourceCreate(command_id=command, expected_version=task["version"],
            kind="file", label="Synthetic local reference", reference="/does/not/exist/public-example.txt")
        with patch.object(Path, "open", side_effect=AssertionError("Resource must not be opened")), \
             patch("urllib.request.urlopen", side_effect=AssertionError("Resource must not be fetched")):
            updated = self.service.resource(task["id"], request)
            self.assertEqual(self.service.resource(task["id"], request), updated)
            self.service.resource(task["id"], models.ResourceCreate(command_id=uuid4(),
                expected_version=updated["version"], kind="url", label="Public reference",
                reference="https://example.invalid/public-document"))
            resources = self.service.detail(task["id"])["resources"]
        self.assertEqual(len(resources), 2)
        self.assertTrue(all(r["source"] == "user" and r["evidence_available"] for r in resources))
        self.assert_error("command_conflict", self.service.resource, task["id"],
            request.model_copy(update={"reference": "/different-public-reference"}))

    def test_user_checkpoint_takes_precedence_and_survives_source_revocation(self):
        self.enable()
        source = self.source()
        self.process(source)
        task = self.service.list_tasks()["items"][0]
        self.assertEqual(self.service.detail(task["id"])["checkpoint"]["source"], "activity")
        self.service.checkpoint(task["id"], models.CheckpointEdit(expected_version=task["version"],
            next_step="Continue the user-owned example", resource_ref="https://example.invalid/public"))
        self.now += timedelta(minutes=5)
        self.process(self.source())
        checkpoint = self.service.detail(task["id"])["checkpoint"]
        self.assertEqual((checkpoint["source"], checkpoint["next_step"]), ("user", "Continue the user-owned example"))
        self.sql("UPDATE context_capture_settings SET consented=0 WHERE id=1")
        self.assertEqual(self.service.detail(task["id"])["checkpoint"], checkpoint)

    def test_source_delete_synchronously_erases_unowned_generated_text_and_refs(self):
        self.enable()
        source = self.source()
        activity = self.process(source)
        task = self.service.list_tasks()["items"][0]
        self.sql("DELETE FROM context_observations WHERE id=?", (source["id"],))
        # Check raw rows before any maintenance-backed read: invalidation must be synchronous.
        raw = self.sql("SELECT * FROM work_tasks WHERE id=?", (task["id"],))[0]
        self.assertEqual((raw["title"], raw["description"], raw["evidence_unavailable"]), ("来源已不可用", "", 1))
        discovery = self.sql("SELECT * FROM work_discoveries")[0]
        self.assertEqual((discovery["title"], discovery["quote"], discovery["state"]), ("", "", "invalidated"))
        self.assertEqual(self.sql("SELECT valid FROM work_activities WHERE id=?", (activity["id"],))[0]["valid"], 0)
        detail = self.service.detail(task["id"])
        self.assertEqual(detail["resources"], [])
        self.assertIsNone(detail["checkpoint"])
        self.assertFalse(detail["activities"][0]["evidence_available"])
        self.assertEqual(detail["activities"][0]["summary"], "")

    def test_revocation_or_revision_change_synchronously_invalidates_all_sources(self):
        for action in ("revoke", "revision"):
            with self.subTest(action=action):
                # Fresh store per subcase is unnecessary: restore a new consent revision.
                self.revision = str(uuid4())
                self.sql("UPDATE context_capture_settings SET consented=1,consent_revision=? WHERE id=1", (self.revision,))
                if not self.service.settings()["auto_discovery"]:
                    self.enable()
                self.process(self.source("TODO(me): " + action + " public task"))
                if action == "revoke":
                    self.sql("UPDATE context_capture_settings SET consented=0 WHERE id=1")
                else:
                    self.sql("UPDATE context_capture_settings SET consent_revision=? WHERE id=1", (str(uuid4()),))
                self.assertTrue(all(r["evidence_unavailable"] and r["title"] == "来源已不可用"
                                    for r in self.sql("SELECT * FROM work_tasks")))
                self.assertTrue(all(r["state"] == "invalidated" and not r["quote"]
                                    for r in self.sql("SELECT * FROM work_discoveries")))

    def test_expiry_and_missing_media_erase_generated_data_before_return(self):
        self.enable()
        sources = [self.source("TODO(me): Expiring public task", expires_at=self.now + timedelta(seconds=1)),
                   self.source("TODO(me): Missing media public task")]
        for source in sources:
            self.process(source)
        path = self.root / "context_engine" / "media" / (sources[1]["evidence_id"] + ".png")
        path.unlink()
        self.now += timedelta(seconds=1)
        self.assertTrue(all(t["evidence_unavailable"] and t["title"] == "来源已不可用"
                            for t in self.service.list_tasks()["items"]))
        self.assertTrue(all(not d["quote"] for d in self.service.discoveries()["items"]))
        self.assertTrue(all(not a["evidence_available"] and not a["resources"]
                            for a in self.service.list_activities()["items"]))

    def test_confirmed_or_user_edited_titles_survive_as_owned_data(self):
        self.enable()
        first, second, third = [self.source("TODO(me): " + name)
                                for name in ("Confirmed public task", "Unowned draft title", "Unconfirmed source title")]
        for source in (first, second, third):
            self.process(source)
        tasks = {t["title"]: t for t in self.service.list_tasks()["items"]}
        self.edit(tasks["Confirmed public task"], confirmed=True)
        self.edit(tasks["Unowned draft title"], title="My owned title", description="My own notes")
        self.edit(tasks["Unconfirmed source title"], description="Only these notes are mine")
        self.sql("UPDATE context_capture_settings SET consented=0 WHERE id=1")
        saved = {t["id"]: t for t in self.service.list_tasks()["items"]}
        self.assertEqual(saved[tasks["Confirmed public task"]["id"]]["title"], "Confirmed public task")
        self.assertEqual(saved[tasks["Unowned draft title"]["id"]]["title"], "My owned title")
        self.assertEqual(saved[tasks["Unowned draft title"]["id"]]["description"], "My own notes")
        self.assertEqual(saved[tasks["Unconfirmed source title"]["id"]]["title"], "来源已不可用")
        self.assertEqual(saved[tasks["Unconfirmed source title"]["id"]]["description"], "Only these notes are mine")

    def test_user_acceptance_of_candidate_preserves_title_on_delete(self):
        self.enable()
        source = self.source("TODO: Review candidate")
        self.process(source)
        candidate = self.service.discoveries()["items"][0]
        task = self.service.resolve(candidate["id"], models.DiscoveryResolution(
            expected_version=candidate["version"], decision="accept"))["task"]
        self.sql("DELETE FROM context_observations WHERE id=?", (source["id"],))
        self.assertEqual(self.current(task)["title"], "Review candidate")
        self.assertTrue(self.current(task)["evidence_unavailable"])

    def test_cannot_confirm_or_relink_invalidated_evidence(self):
        self.enable()
        source = self.source()
        activity = self.process(source)
        task = self.service.list_tasks()["items"][0]
        self.sql("DELETE FROM context_observations WHERE id=?", (source["id"],))
        self.assert_error("evidence_unavailable", self.edit, task, confirmed=True)
        self.assert_error("evidence_unavailable", self.link, task, activity)

    def test_provider_proposal_must_be_exactly_grounded_and_entire_batch_is_atomic(self):
        self.enable()
        source = self.source()
        self.service.provider = Mock(extract=Mock(return_value=[
            Proposal("Review public example", "TODO(me): Review public example", True, True, .95),
            Proposal("Invented task", "Invented task", True, True, .99),
        ]))
        self.assert_error("invalid_discovery_result", self.service.process_observation, source["id"])
        self.assertEqual(self.sql("SELECT * FROM work_tasks"), [])
        self.assertEqual(self.sql("SELECT valid FROM work_activities"), [{"valid": 1}])
        self.assertEqual(self.sql("SELECT * FROM work_discoveries"), [])
        self.assertEqual(self.sql("SELECT * FROM work_task_links"), [])

    def test_mocked_local_model_receives_only_grounded_excerpts_and_runs_once(self):
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.commit_guard.side_effect = synthetic_commit_guard
        model.available.return_value = True
        model.extract.return_value = [Proposal("Review public example", "TODO(me): Review public example", True, True, .95)]
        self.service.model_provider = model
        self.enable("local_model_v1")
        source = self.source()
        self.process(source)
        self.service.sync()
        self.service.sync()
        model.extract.assert_called_once()
        self.assertEqual(model.extract.call_args.args[0].text, "TODO(me): Review public example")
        self.assertEqual(self.service.list_tasks()["items"], [])
        self.assertEqual(self.sql("SELECT state,task_id FROM work_discoveries"),
                         [{"state": "pending", "task_id": None}])
        self.assertEqual(self.sql("SELECT * FROM work_task_links"), [])
        self.assertFalse(self.service.settings()["last_error"])

    def test_local_model_optout_revocation_and_source_change_races_never_commit(self):
        for action in ("optout", "revoke", "replace", "media_replace", "expire"):
            with self.subTest(action=action):
                model = Mock(spec=("available", "extract", "commit_guard"))
                model.commit_guard.side_effect = synthetic_commit_guard
                model.available.return_value = True
                self.service.model_provider = model
                self.revision = str(uuid4())
                self.sql("UPDATE context_capture_settings SET consented=1,consent_revision=? WHERE id=1", (self.revision,))
                self.enable("local_model_v1")
                source = self.source()
                def extract(excerpts, *, validate, cancel_event):
                    validate()
                    if action == "optout":
                        self.service.set_settings(models.SettingsEdit(expected_version=self.service.settings()["version"],
                            auto_discovery=False, confirmed=True, provider="local_model_v1"))
                    elif action == "revoke":
                        self.sql("UPDATE context_capture_settings SET consented=0 WHERE id=1")
                    elif action == "replace":
                        self.sql("UPDATE context_observations SET post_mask_ocr_text='Changed public source' WHERE id=?", (source["id"],))
                    elif action == "media_replace":
                        path = self.root / "context_engine" / "media" / (source["evidence_id"] + ".png")
                        path.write_bytes(b"different synthetic media bytes")
                    else:
                        self.now += timedelta(days=2)
                    self.assertTrue(cancel_event.is_set())
                    return [Proposal("Review public example", excerpts.text, True, True, .95)]
                model.extract.side_effect = extract
                self.assert_error("discovery_authorization_changed", self.service.process_observation, source["id"])
                self.assertEqual(self.sql("SELECT * FROM work_tasks"), [])
                self.assertEqual(self.sql("SELECT valid FROM work_activities WHERE source_record_id=?", (source["id"],)),
                                 [{"valid": int(action == "optout")}])
                self.assertEqual(self.sql("SELECT * FROM work_discoveries"), [])
                self.assertEqual(self.sql("SELECT * FROM work_task_links"), [])
                activity = next(a for a in self.service.list_activities()["items"] if a["source_record_id"] == source["id"])
                self.assertEqual(activity["evidence_available"], action == "optout")

    def test_accepting_pending_candidate_updates_version_even_if_task_already_done(self):
        self.enable()
        self.process(self.source("TODO: Confirm public example"))
        candidate = self.service.discoveries()["items"][0]
        self.process(self.source("TODO(me): Confirm public example"))
        task = self.service.list_tasks()["items"][0]
        task = self.edit(task, status="done")
        self.assertFalse(task["confirmed"])
        result = self.service.resolve(candidate["id"], models.DiscoveryResolution(
            expected_version=candidate["version"], decision="accept"))["task"]
        self.assertTrue(result["confirmed"])
        self.assertEqual(result["status"], "done")
        self.assertGreater(result["version"], task["version"])
        self.assert_error("version_conflict", self.service.edit_task, task["id"],
            models.TaskEdit(expected_version=task["version"], title="Stale after confirmation"))

    def test_pending_candidates_across_sources_accept_into_one_exact_task(self):
        self.enable()
        for _ in range(2):
            self.process(self.source("TODO: Same public candidate"))
        ids = []
        for candidate in self.service.discoveries()["items"]:
            result = self.service.resolve(candidate["id"], models.DiscoveryResolution(
                expected_version=candidate["version"], decision="accept"))
            ids.append(result["task"]["id"])
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(len(self.service.list_tasks()["items"]), 1)
        self.assertEqual(len(self.service.detail(ids[0])["activities"]), 2)

    def test_dismissal_remains_after_source_delete_without_retaining_source_text(self):
        self.enable()
        source = self.source("TODO: Dismiss public proposal")
        self.process(source)
        candidate = self.service.discoveries()["items"][0]
        self.service.resolve(candidate["id"], models.DiscoveryResolution(
            expected_version=candidate["version"], decision="dismiss"))
        self.sql("DELETE FROM context_observations WHERE id=?", (source["id"],))
        old = self.sql("SELECT * FROM work_discoveries WHERE id=?", (candidate["id"],))[0]
        self.assertEqual((old["title"], old["quote"], old["state"]), ("", "", "invalidated"))
        tombstones = self.sql("SELECT * FROM work_discovery_suppressions")
        self.assertEqual(len(tombstones), 1)
        self.assertNotIn("Dismiss public proposal", json.dumps(tombstones))
        self.process(self.source("TODO(me): Dismiss public proposal"))
        self.assertEqual(self.service.list_tasks()["items"], [])
        self.assertEqual(self.service.discoveries()["items"][0]["state"], "dismissed")

    def test_additive_schema_is_readable_by_old_capture_initializer_and_reopen(self):
        user_task = self.task("User task preserved on rollback", priority="high")
        self.enable()
        source = self.source()
        self.process(source)
        generated = next(t for t in self.service.list_tasks()["items"] if t["created_by"] == "assistant")
        original_schema = self.sql("SELECT name,sql FROM sqlite_master WHERE name GLOB 'context_*' ORDER BY name")
        # Simulate old capture code opening an isolated copy of the synthetic database.
        original_path = self.path
        self.path = self.root / "synthetic-rollback.sqlite3"
        shutil.copyfile(original_path, self.path)
        with self.connect() as conn:
            init_capture_store(conn)
            conn.execute("DELETE FROM context_observations WHERE id=?", (source["id"],))
        self.assertEqual(self.sql("SELECT name,sql FROM sqlite_master WHERE name GLOB 'context_*' ORDER BY name"), original_schema)
        raw = self.sql("SELECT * FROM work_tasks WHERE id=?", (generated["id"],))[0]
        self.assertEqual((raw["title"], raw["evidence_unavailable"]), ("来源已不可用", 1))
        reopened = TaskService(self.path, clock=lambda: self.now)
        self.assertEqual(reopened.detail(user_task["id"])["task"], user_task)
        self.assertEqual(reopened.detail(generated["id"])["resources"], [])
        self.path = original_path
        self.assertEqual(self.service.detail(generated["id"])["task"]["title"], "Review public example")

    def test_sync_recovers_past_first_rules_batch_without_duplicate_dispatch(self):
        self.enable()
        for index in range(201):
            self.source("TODO(me): Public batch task " + str(index))
        first = self.service.sync()
        self.assertEqual(first, {"processed": 200, "bounded_to": 200, "has_more": True, "skipped_invalid": 0})
        second = self.service.sync()
        self.assertEqual(second, {"processed": 1, "bounded_to": 200, "has_more": False, "skipped_invalid": 0})
        self.assertEqual(self.service.sync()["processed"], 0)
        self.assertEqual(len(self.service.list_tasks()["items"]), 201)

    def test_sync_missing_media_does_not_starve_later_valid_observations(self):
        self.enable()
        missing = self.source("TODO(me): Unavailable public task", media=False)
        self.now += timedelta(seconds=1)
        valid = self.source("TODO(me): Available public task")
        result = self.service.sync()
        self.assertEqual(result["processed"], 1)
        self.assertFalse(result["has_more"])
        self.assertEqual([t["title"] for t in self.service.list_tasks()["items"]], ["Available public task"])
        receipts = self.sql("SELECT source_record_id,valid FROM work_activities")
        self.assertEqual({r["source_record_id"]: r["valid"] for r in receipts}, {missing["id"]: 0, valid["id"]: 1})
        self.assertEqual(self.service.sync()["processed"], 0)

    def test_local_model_sync_dispatches_one_source_per_explicit_batch(self):
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.commit_guard.side_effect = synthetic_commit_guard
        model.available.return_value = True
        model.extract.side_effect = lambda excerpts, **kwargs: [Proposal(
            excerpts.text.split(": ", 1)[1], excerpts.text, True, True, .95)]
        self.service.model_provider = model
        self.enable("local_model_v1")
        for index in range(3):
            self.source("TODO(me): Model batch task " + str(index))
        for index in range(3):
            result = self.service.sync()
            self.assertEqual(result, {"processed": 1, "bounded_to": 1, "has_more": index < 2, "skipped_invalid": 0})
            self.assertEqual(model.extract.call_count, index + 1)
        self.assertEqual(self.service.sync()["processed"], 0)
        self.assertEqual(model.extract.call_count, 3)

    def test_callback_cancel_or_shutdown_prevents_inflight_model_commit(self):
        for action in ("cancel", "close"):
            with self.subTest(action=action):
                cancellation = Event()
                model = Mock(spec=("available", "extract", "commit_guard"))
                model.commit_guard.side_effect = synthetic_commit_guard
                model.available.return_value = True
                self.service = TaskService(self.path, clock=lambda: self.now, model_provider=model)
                self.enable("local_model_v1")
                source = self.source()
                def extract(excerpts, *, validate, cancel_event):
                    validate()
                    if action == "cancel":
                        cancellation.set()
                    else:
                        self.service.close()
                    self.assertTrue(cancel_event.is_set())
                    return [Proposal("Review public example", excerpts.text, True, True, .95)]
                model.extract.side_effect = extract
                self.assert_error("discovery_authorization_changed", self.service.process_observation,
                                  source["id"], cancel_event=cancellation)
                self.assertEqual(self.sql("SELECT * FROM work_tasks"), [])
                self.assertEqual(self.sql("SELECT valid FROM work_activities WHERE source_record_id=?", (source["id"],)), [{"valid": 1}])
                self.assertEqual(self.sql("SELECT * FROM work_discoveries"), [])
                self.assertEqual(self.sql("SELECT * FROM work_task_links"), [])

    def test_cancelled_callback_and_closed_service_never_dispatch(self):
        cancellation = Event()
        cancellation.set()
        self.enable()
        source = self.source()
        self.service.provider = Mock()
        self.assertEqual(self.service.process_observation(source["id"], cancel_event=cancellation),
                         {"processed": False, "reason": "cancelled"})
        self.service.close()
        self.assertEqual(self.service.process_observation(source["id"]),
                         {"processed": False, "reason": "cancelled"})
        self.service.provider.extract.assert_not_called()
        self.assertEqual(self.sql("SELECT * FROM work_activities"), [])

    def test_observation_queue_calls_task_indexer_with_original_cancellation(self):
        self.enable()
        source = self.source()
        cancellation = Event()
        captures = Mock()
        captures.processing_ticket.return_value = (1, cancellation)
        captures.begin_processing.return_value = b"synthetic placeholder never decoded"
        processor = Mock()
        processor.process.return_value = True
        callback = Mock(wraps=self.service.process_observation)
        queue = ObservationQueue(captures, processor, on_processed=callback)
        self.addCleanup(queue.close)
        self.assertTrue(queue.submit(source["id"])["accepted"])
        self.assertTrue(queue.wait_idle())
        callback.assert_called_once_with(source["id"], cancel_event=cancellation)
        self.assertEqual([t["title"] for t in self.service.list_tasks()["items"]], ["Review public example"])
        captures.set_result.assert_not_called()

    def test_task_callback_failure_does_not_relabel_successful_observation(self):
        source = self.source()
        cancellation = Event()
        captures = Mock()
        captures.processing_ticket.return_value = (1, cancellation)
        captures.begin_processing.return_value = b"synthetic placeholder never decoded"
        processor = Mock()
        processor.process.return_value = True
        callback = Mock(side_effect=TaskError("synthetic_task_error"))
        queue = ObservationQueue(captures, processor, on_processed=callback)
        self.addCleanup(queue.close)
        self.assertTrue(queue.submit(source["id"])["accepted"])
        self.assertTrue(queue.wait_idle())
        callback.assert_called_once()
        captures.set_result.assert_not_called()
        self.assertEqual(self.sql("SELECT state FROM context_observations WHERE id=?", (source["id"],))[0]["state"], "ready")

    def test_runtime_bridge_persists_expiry_or_missing_media_scrub_before_stale_version_error(self):
        self.enable()
        for reason in ("expired", "missing_media"):
            with self.subTest(reason=reason):
                source = self.source("TODO(me): Public bridge " + reason,
                                     expires_at=self.now + timedelta(seconds=1))
                self.process(source)
                task = next(t for t in self.service.list_tasks()["items"]
                            if t["title"] == "Public bridge " + reason)
                if reason == "expired":
                    self.now += timedelta(seconds=2)
                else:
                    path = self.root / "context_engine" / "media" / (source["evidence_id"] + ".png")
                    path.unlink()
                self.assert_error("version_conflict", self.service.runtime_bridge, task["id"],
                    models.RuntimeBridge(expected_version=task["version"], goal_id=None))
                # Inspect persisted rows without allowing another read to conceal a rolled-back purge.
                raw = self.sql("SELECT * FROM work_tasks WHERE id=?", (task["id"],))[0]
                self.assertEqual((raw["title"], raw["description"], raw["evidence_unavailable"]),
                                 ("来源已不可用", "", 1))
                discovery = self.sql("SELECT title,quote,state FROM work_discoveries WHERE task_id=?", (task["id"],))[0]
                self.assertEqual(discovery, {"title": "", "quote": "", "state": "invalidated"})
                returned = self.service.runtime_bridge(task["id"],
                    models.RuntimeBridge(expected_version=raw["version"], goal_id=None))
                self.assertEqual(returned["title"], "来源已不可用")
                self.assertTrue(returned["evidence_unavailable"])

    def test_pending_discovery_stays_visible_after_more_than_500_accepted_records(self):
        self.enable()
        source = self.source("TODO: Earlier pending public work")
        self.process(source)
        pending = self.service.discoveries()["items"][0]
        for group in range(167):
            source = self.source("\n".join("TODO(me): Public accepted queue record " + str(group * 3 + i)
                                           for i in range(3)))
            self.assertTrue(self.service.process_observation(source["id"])["processed"])
        self.assertEqual(self.sql("SELECT count(*) AS n FROM work_discoveries WHERE state='accepted'")[0]["n"], 501)
        result = self.service.discoveries()
        self.assertEqual(len(result["items"]), 500)
        self.assertEqual(result["items"][0]["id"], pending["id"])
        self.assertEqual(result["pending_count"], 1)
        self.assertFalse(result["has_more_pending"])

    def test_more_than_500_pending_discoveries_expose_total_and_reveal_older_work_after_resolution(self):
        self.enable()
        for group in range(167):
            source = self.source("\n".join("TODO: Public pending queue record " + str(group * 3 + i)
                                           for i in range(3)))
            self.assertTrue(self.service.process_observation(source["id"])["processed"])
        result = self.service.discoveries()
        self.assertEqual(len(result["items"]), 500)
        self.assertTrue(all(d["state"] == "pending" for d in result["items"]))
        self.assertEqual(result["pending_count"], 501)
        self.assertTrue(result["has_more_pending"])
        first = result["items"][0]
        shown = {d["id"] for d in result["items"]}
        self.service.resolve(first["id"], models.DiscoveryResolution(
            expected_version=first["version"], decision="dismiss"))
        updated = self.service.discoveries()
        self.assertEqual(updated["pending_count"], 500)
        self.assertFalse(updated["has_more_pending"])
        self.assertEqual(len(updated["items"]), 500)
        self.assertNotIn(first["id"], {d["id"] for d in updated["items"]})
        self.assertEqual(len({d["id"] for d in updated["items"]} - shown), 1)

    def test_expired_unowned_task_reobservation_requires_review_and_creates_new_owned_task(self):
        self.enable()
        original_source = self.source("TODO(me): Revisit public example", expires_at=self.now + timedelta(seconds=1))
        self.process(original_source)
        original = self.service.list_tasks()["items"][0]
        self.now += timedelta(seconds=2)
        current_source = self.source("TODO(me): Revisit public example")
        activity = self.process(current_source)
        tasks = self.service.list_tasks()["items"]
        self.assertEqual(len(tasks), 1)
        self.assertEqual((tasks[0]["id"], tasks[0]["title"], tasks[0]["evidence_unavailable"]),
                         (original["id"], "来源已不可用", True))
        pending = next(d for d in self.service.discoveries()["items"] if d["state"] == "pending")
        self.assertEqual((pending["title"], pending["activity_id"], pending["task_id"]),
                         ("Revisit public example", activity["id"], None))
        self.assertEqual(self.service.detail(original["id"])["resources"], [])
        accepted = self.service.resolve(pending["id"], models.DiscoveryResolution(
            expected_version=pending["version"], decision="accept"))["task"]
        self.assertNotEqual(accepted["id"], original["id"])
        self.assertEqual(accepted["title"], "Revisit public example")
        self.assertTrue(accepted["confirmed"])
        self.assertFalse(accepted["evidence_unavailable"])
        fresh = self.service.detail(accepted["id"])
        self.assertEqual([a["id"] for a in fresh["activities"]], [activity["id"]])
        self.assertEqual(fresh["resources"][0]["reference"], current_source["evidence_id"])
        old = self.service.detail(original["id"])
        self.assertEqual((old["task"]["title"], old["task"]["evidence_unavailable"]), ("来源已不可用", True))
        self.assertFalse(old["activities"][0]["evidence_available"])

    def test_model_publication_requires_explicit_guard_and_failure_never_commits(self):
        for guard in ("missing", "denied"):
            with self.subTest(guard=guard):
                model = Mock(spec=("available", "extract") if guard == "missing" else
                             ("available", "extract", "commit_guard"))
                model.available.return_value = True
                model.extract.return_value = [Proposal("Review public example", "TODO(me): Review public example", True, True, .95)]
                if guard == "denied":
                    model.commit_guard.side_effect = PermissionError("synthetic_authorization_revoked")
                self.service.model_provider = model
                self.enable("local_model_v1")
                source = self.source()
                self.assert_error("local_discovery_failed", self.service.process_observation, source["id"])
                self.assertEqual(self.sql("SELECT * FROM work_tasks"), [])
                self.assertEqual(self.sql("SELECT valid FROM work_activities WHERE source_record_id=?", (source["id"],)), [{"valid": 1}])
                self.assertEqual(self.sql("SELECT * FROM work_discoveries"), [])
                self.assertEqual(self.sql("SELECT * FROM work_task_links"), [])

    def test_task_and_discovery_provider_attribution_distinguishes_manual_rules_and_local_model(self):
        manual = self.task("Manual provider label")
        self.assertIsNone(manual["discovery_provider"])
        self.enable()
        self.process(self.source("TODO(me): Rule provider label"))
        rules = next(t for t in self.service.list_tasks()["items"] if t["title"] == "Rule provider label")
        self.assertEqual(rules["discovery_provider"], "evidence_rules_v1")
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.available.return_value = True
        model.commit_guard.side_effect = synthetic_commit_guard
        model.extract.return_value = [Proposal("Local provider label", "TODO(me): Local provider label", True, True, .95)]
        self.service.model_provider = model
        self.enable("local_model_v1")
        self.process(self.source("TODO(me): Local provider label"))
        candidate = next(d for d in self.service.discoveries()["items"] if d["title"] == "Local provider label")
        self.assertEqual((candidate['state'], candidate['task_id']), ('pending', None))
        local = self.service.resolve(candidate['id'], models.DiscoveryResolution(
            expected_version=candidate['version'], decision='accept'))['task']
        self.assertEqual(local["discovery_provider"], "local_model_v1")
        discoveries = {d["title"]: d["provider"] for d in self.service.discoveries()["items"]}
        self.assertEqual(discoveries, {"Rule provider label": "evidence_rules_v1", "Local provider label": "local_model_v1"})
        reopened = TaskService(self.path, clock=lambda: self.now, model_provider=model)
        self.assertIsNone(reopened.detail(manual["id"])["task"]["discovery_provider"])
        self.assertEqual(reopened.detail(rules["id"])["task"]["discovery_provider"], "evidence_rules_v1")
        self.assertEqual(reopened.detail(local["id"])["task"]["discovery_provider"], "local_model_v1")

    def test_candidate_confirmation_retains_original_provider_after_settings_change(self):
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.available.return_value = True
        model.commit_guard.side_effect = synthetic_commit_guard
        model.extract.side_effect = lambda excerpts, **kwargs: [Proposal(
            excerpts.text.split(": ", 1)[1], excerpts.text, False, True, .6)]
        self.service.model_provider = model
        for provider in ("evidence_rules_v1", "local_model_v1"):
            with self.subTest(provider=provider):
                self.enable(provider)
                title = "Candidate from " + provider
                self.process(self.source("TODO: " + title))
                pending = next(d for d in self.service.discoveries()["items"] if d["title"] == title)
                self.assertEqual((pending["provider"], pending["state"]), (provider, "pending"))
                self.enable("local_model_v1" if provider == "evidence_rules_v1" else "evidence_rules_v1")
                task = self.service.resolve(pending["id"], models.DiscoveryResolution(
                    expected_version=pending["version"], decision="accept"))["task"]
                self.assertEqual(task["discovery_provider"], provider)
                self.assertTrue(task["confirmed"])

    def test_later_local_model_association_does_not_relabel_existing_manual_or_rule_task(self):
        manual = self.task("Existing manual attribution")
        self.enable()
        self.process(self.source("TODO(me): Existing rule attribution"))
        rules = next(t for t in self.service.list_tasks()["items"] if t["title"] == "Existing rule attribution")
        model = Mock(spec=("available", "extract", "commit_guard"))
        model.available.return_value = True
        model.commit_guard.side_effect = synthetic_commit_guard
        model.extract.side_effect = lambda excerpts, **kwargs: [Proposal(
            excerpts.text.split(": ", 1)[1], excerpts.text, True, True, .95)]
        self.service.model_provider = model
        self.enable("local_model_v1")
        for title in (manual["title"], rules["title"]):
            self.process(self.source("TODO(me): " + title))
        self.assertIsNone(self.current(manual)["discovery_provider"])
        self.assertEqual(self.current(rules)["discovery_provider"], "evidence_rules_v1")
        self.assertEqual(len(self.service.list_tasks()["items"]), 2)
        self.assertEqual(sum(d["provider"] == "local_model_v1" for d in self.service.discoveries()["items"]), 2)

    def test_legacy_schema_migration_defaults_old_assistant_and_discovery_providers_to_unknown(self):
        manual = self.task("Historical manual attribution")
        self.enable()
        self.process(self.source("TODO(me): Historical assistant attribution"))
        self.process(self.source("TODO: Historical pending attribution"))
        assistant = next(t for t in self.service.list_tasks()["items"] if t["created_by"] == "assistant")
        sources = self.sql("SELECT * FROM context_observations ORDER BY id")
        self.service.close()
        # Remove only the newly introduced columns on this isolated synthetic
        # database to represent the exact pre-attribution schema.
        with self.connect() as conn:
            conn.execute("ALTER TABLE work_tasks DROP COLUMN discovery_provider")
            conn.execute("ALTER TABLE work_discoveries DROP COLUMN provider")
        self.service = TaskService(self.path, clock=lambda: self.now)
        self.assertIsNone(self.current(manual)["discovery_provider"])
        self.assertEqual(self.current(assistant)["discovery_provider"], "unknown")
        discoveries = self.service.discoveries()["items"]
        self.assertTrue(all(d["provider"] == "unknown" for d in discoveries))
        pending = next(d for d in discoveries if d["state"] == "pending")
        confirmed = self.service.resolve(pending["id"], models.DiscoveryResolution(
            expected_version=pending["version"], decision="accept"))["task"]
        self.assertEqual(confirmed["discovery_provider"], "unknown")
        self.assertEqual(self.sql("SELECT * FROM context_observations ORDER BY id"), sources)
        reopened = TaskService(self.path, clock=lambda: self.now)
        self.assertEqual(reopened.detail(assistant["id"])["task"]["discovery_provider"], "unknown")

    def test_unavailable_local_model_cannot_be_enabled(self):
        self.assert_error("local_model_unavailable", self.service.set_settings,
            models.SettingsEdit(expected_version=1, auto_discovery=True, confirmed=True, provider="local_model_v1"))
        self.assertFalse(self.service.settings()["auto_discovery"])


if __name__ == "__main__":
    unittest.main()
