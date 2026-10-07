"""Durable, explicitly selected local synthetic text-planner control.

Selection is always read from SQLite. Validated adapter instances are merely a
cache indexed by the complete configuration and revision, never an authority.
All dispatch paths take the runtime transaction before any Gateway lock. No
constructor, read, restore, selection or idle path sends a validation probe.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta
from threading import Lock

from app.modules.model_gateway import Gateway, ModelRoute
from app.security.privacy_guard import PrivacyGuard

from .model_planner import ModelPlanner
from .models import AuthorizationError, Conflict, PlannerUnavailable, RuntimeErrorBase
from .planner import DeterministicPlanner
from .store import encode, new_id

SETTING_KEY = "planner_selection"
USAGE_KEY = "planner_daily_usage"
DAILY_LIMIT = 20
MODES = frozenset({"deterministic", "local_model"})
SCOPE = "synthetic_only"
_FAILURES = {None, "local_text_probe_failed", "model_planner_unavailable", "planner_configuration_invalid"}
_STATE_KEYS = {"schema_version", "mode", "revision", "configuration", "confirmed",
               "validated_configuration", "last_attempt", "last_failure"}


def _default_state():
    return {"schema_version": 1, "mode": "deterministic", "revision": 0,
            "configuration": None, "confirmed": False, "validated_configuration": None,
            "last_attempt": "never", "last_failure": None}


def _route(configuration):
    if (not isinstance(configuration, dict)
            or set(configuration) != {"protocol", "endpoint", "model", "scope"}
            or configuration["scope"] != SCOPE
            or not isinstance(configuration["endpoint"], str)
            or len(configuration["endpoint"]) > 512
            or not isinstance(configuration["model"], str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}", configuration["model"]) is None):
        raise ValueError("invalid_local_planner_configuration")
    return ModelRoute(protocol=configuration["protocol"], mode="local",
                      endpoint=configuration["endpoint"], model=configuration["model"])


class PlannerControl:
    """Stable Planner facade; durable selection changes its revision atomically."""

    def __init__(self, service, *, gateway_factory=None):
        self.service = service
        self.store = service.store
        # A dedicated Gateway cannot inherit image, remote, credential or
        # previous-session model consent. The default transport is HTTP-backed.
        self._gateway_factory = gateway_factory or (lambda: Gateway(PrivacyGuard()))
        self._deterministic = DeterministicPlanner()
        self._cache = {}
        self._cache_lock = Lock()
        self._reservation_lock = Lock()
        self._reserved_tokens = {}

    def _load(self, connection):
        row = connection.execute("SELECT value FROM runtime_settings WHERE key=?", (SETTING_KEY,)).fetchone()
        if row is None:
            return _default_state()
        state = None
        try:
            state = json.loads(row["value"])
            if (not isinstance(state, dict) or set(state) != _STATE_KEYS
                    or type(state["schema_version"]) is not int or state["schema_version"] != 1
                    or state["mode"] not in MODES
                    or type(state["revision"]) is not int or state["revision"] < 0
                    or type(state["confirmed"]) is not bool
                    or state["last_attempt"] not in {"never", "passed", "failed"}
                    or state["last_failure"] not in _FAILURES):
                raise ValueError
            config, validated = state["configuration"], state["validated_configuration"]
            if config is None:
                if state["confirmed"] or validated is not None or state["mode"] != "deterministic":
                    raise ValueError
            else:
                route = _route(config)
                if state["confirmed"] is not True:
                    raise ValueError
                if validated is not None:
                    expected = {"schema_version": 1, "consent": True, "allowed_sources": ["synthetic"],
                                "route": {"protocol": route.protocol, "mode": "local",
                                          "endpoint": route.endpoint, "model": route.model}}
                    # JSON's bool/int equality must not forge a schema marker.
                    if encode(validated) != encode(expected):
                        raise ValueError
            return state
        except (TypeError, ValueError, KeyError):
            # Corruption never becomes an implicit deterministic fallback. A
            # known deterministic selection remains truthful but is blocked
            # until an explicit configure/select repairs the malformed state.
            blocked = _default_state()
            blocked["mode"] = state.get("mode") if isinstance(state, dict) and isinstance(state.get("mode"), str) and state.get("mode") in MODES else "local_model"
            if isinstance(state, dict) and type(state.get("revision")) is int and state["revision"] >= 0:
                blocked["revision"] = state["revision"]
            blocked.update(last_failure="planner_configuration_invalid", invalid=True)
            return blocked

    @staticmethod
    def _key(state):
        return hashlib.sha256(encode({"revision": state["revision"],
                                     "configuration": state["configuration"],
                                     "validated_configuration": state["validated_configuration"]}).encode()).hexdigest()

    def _adapter(self, state):
        if state.get("invalid") or state["validated_configuration"] is None:
            raise PlannerUnavailable("planner_configuration_invalid")
        key = self._key(state)
        with self._cache_lock:
            adapter = self._cache.get(key)
            if adapter is None:
                adapter = ModelPlanner(self._gateway_factory(), allowed_sources=frozenset({"synthetic"}))
                adapter.restore_validated_configuration(state["validated_configuration"])
                self._cache[key] = adapter
                while len(self._cache) > 8:
                    del self._cache[next(iter(self._cache))]
        return adapter

    def _save(self, connection, state):
        connection.execute("INSERT INTO runtime_settings (key,value) VALUES (?,?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (SETTING_KEY, encode(state)))

    def _invalidate(self, connection, state):
        row = connection.execute("SELECT value FROM runtime_settings WHERE key='execution_epoch'").fetchone()
        epoch = (json.loads(row["value"]) if row is not None else 0) + 1
        connection.execute("INSERT INTO runtime_settings (key,value) VALUES ('execution_epoch',?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (encode(epoch),))
        connection.execute("UPDATE wakes SET status='queued',lease_token=NULL,lease_until=NULL,"
                           "reason='planner_configuration_changed' WHERE status='running'")
        self.service._clear_proposals(connection)
        from .conversation_store import invalidate_conversations
        invalidate_conversations(connection, self.service, "conversation_route_changed", self.service.now())
        now = self.service.now()
        # No execution is started here. Durable recovery wakes are consumed only
        # if enabled; waiting goals can continue after an explicit route switch.
        for row in connection.execute("SELECT id FROM goals WHERE status IN ('active','waiting_external')"):
            self.service._enqueue(connection, row["id"], "recovery",
                                  f"planner:{state['revision']}:{epoch}", now, now)

    @property
    def name(self):
        with self.store.read() as connection:
            return ModelPlanner.name if self._load(connection)["mode"] == "local_model" else self._deterministic.name

    @property
    def configuration_revision(self):
        with self.store.read() as connection:
            return self._load(connection)["revision"]

    @property
    def allowed_sources(self):
        with self.store.read() as connection:
            return (frozenset({"synthetic"}) if self._load(connection)["mode"] == "local_model"
                    else frozenset({"synthetic", "user_statement"}))

    def _usage_record(self, connection):
        day = self.service.now()[:10]
        empty = {"day": day, "count": 0, "reservations": []}
        row = connection.execute("SELECT value FROM runtime_settings WHERE key=?", (USAGE_KEY,)).fetchone()
        if row is None:
            return empty
        try:
            usage = json.loads(row["value"])
            if (not isinstance(usage, dict) or set(usage) not in ({"day", "count"}, {"day", "count", "reservations"})
                    or not isinstance(usage["day"], str)
                    or re.fullmatch(r"\d{4}-\d{2}-\d{2}", usage["day"]) is None
                    or type(usage["count"]) is not int or not 0 <= usage["count"] <= DAILY_LIMIT):
                raise ValueError
            reservations = usage.get("reservations", [])
            if (not isinstance(reservations, list) or len(reservations) > usage["count"]
                    or any(not isinstance(item, dict) or set(item) != {"token", "revision"}
                           or not isinstance(item["token"], str) or len(item["token"]) > 128
                           or type(item["revision"]) is not int or item["revision"] < 0
                           for item in reservations)
                    or len({item["token"] for item in reservations}) != len(reservations)):
                raise ValueError
            if usage["day"] < day:
                return empty
            return {**usage, "reservations": reservations}
        except (ValueError, TypeError, KeyError):
            # An unreadable counter cannot grant a fresh allowance.
            return {"day": day, "count": DAILY_LIMIT, "reservations": []}

    def _usage(self, connection):
        now = self.service.now()
        next_day = datetime.fromisoformat(now).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        used = self._usage_record(connection)["count"]
        return {"limit": DAILY_LIMIT, "used": used, "remaining": DAILY_LIMIT - used,
                "resets_at": next_day.isoformat(timespec="microseconds")}

    @staticmethod
    def _save_usage(connection, usage):
        connection.execute("INSERT INTO runtime_settings (key,value) VALUES (?,?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (USAGE_KEY, encode(usage)))

    def reserve_attempt(self, connection, claimed_revision):
        """Reserve before dispatch in an outer transaction committed by engine.

        Crashes, lost leases and abandoned reservations remain conservatively
        charged. The one-shot process-local handle is valid only alongside its
        durable record, and never carries over to a restarted manager.
        """
        from .models import PlannerBudgetExceeded
        state = self._load(connection)
        if state.get("invalid") or state["revision"] != claimed_revision:
            raise PlannerUnavailable("planner_selection_changed")
        if state["mode"] != "local_model":
            return None
        self._adapter(state)  # strict restore only; no network
        budget = self._usage(connection)
        if budget["remaining"] <= 0:
            raise PlannerBudgetExceeded(budget["resets_at"])
        usage = self._usage_record(connection)
        token = new_id("model_attempt")
        usage["count"] += 1
        usage["reservations"].append({"token": token, "revision": claimed_revision})
        self._save_usage(connection, usage)
        with self._reservation_lock:
            self._reserved_tokens[token] = {"connection": connection, "day": usage["day"], "revision": claimed_revision}
            while len(self._reserved_tokens) > DAILY_LIMIT * 2:
                del self._reserved_tokens[next(iter(self._reserved_tokens))]
        return token

    def _consume_attempt(self, connection, state, token):
        usage = self._usage_record(connection)
        expected = {"token": token, "revision": state["revision"]}
        with self._reservation_lock:
            local = self._reserved_tokens.get(token) if isinstance(token, str) else None
            if (local is None or local["connection"] is connection
                    or local["day"] != self.service.now()[:10] or usage["day"] != local["day"]
                    or local["revision"] != state["revision"] or expected not in usage["reservations"]):
                raise PlannerUnavailable("committed_model_attempt_required")
            del self._reserved_tokens[token]
        usage["reservations"].remove(expected)
        self._save_usage(connection, usage)

    def _status(self, state):
        model_ready = False
        last_failure = state["last_failure"]
        if state["validated_configuration"] is not None and not state.get("invalid"):
            try:
                model_ready = bool(self._adapter(state).status()["ready"])
            except Exception:
                last_failure = "planner_configuration_invalid"
        if last_failure == "model_planner_unavailable":
            model_ready = False
        with self.store.read() as connection:
            budget = self._usage(connection)
        return {"selected_mode": state["mode"],
                "name": ModelPlanner.name if state["mode"] == "local_model" else self._deterministic.name,
                "ready": not state.get("invalid", False) and (state["mode"] == "deterministic" or model_ready),
                "configured": state["configuration"] is not None,
                "model_ready": model_ready,
                "needs_validation": (state.get("invalid", False) or state["validated_configuration"] is None
                                     or last_failure == "planner_configuration_invalid"),
                "configuration_revision": state["revision"], "configuration": state["configuration"],
                "confirmed": state["confirmed"], "last_attempt": state["last_attempt"],
                "last_failure": last_failure, "model_allowed_sources": ["synthetic"],
                "boundary": "synthetic_loopback_only", "daily_budget": budget}

    def status(self):
        with self.store.transaction() as connection:
            return self._status(self._load(connection))

    def configure(self, *, protocol, endpoint, model, scope, confirmed=False):
        if confirmed is not True or scope != SCOPE:
            raise AuthorizationError("explicit_synthetic_model_processing_consent_required")
        configuration = {"protocol": protocol, "endpoint": endpoint, "model": model, "scope": scope}
        try:
            route = _route(configuration)
        except (TypeError, ValueError):
            raise RuntimeErrorBase("invalid_local_planner_configuration") from None
        with self.store.transaction() as connection:
            previous = self._load(connection)
            state = {**_default_state(), "mode": previous["mode"], "revision": previous["revision"] + 1,
                     "configuration": configuration, "confirmed": True}
            adapter = ModelPlanner(self._gateway_factory(), allowed_sources=frozenset({"synthetic"}))
            try:
                adapter.configure(route, consent=True)
                # Persist exactly the adapter's capability after the synthetic
                # probe, never a validation marker synthesized from a request.
                state["validated_configuration"] = adapter.export_validated_configuration()
                state["last_attempt"] = "passed"
                with self._cache_lock:
                    self._cache[self._key(state)] = adapter
                    while len(self._cache) > 8:
                        del self._cache[next(iter(self._cache))]
            except Exception:
                state["last_attempt"] = "failed"
                state["last_failure"] = "local_text_probe_failed"
            self._invalidate(connection, state)
            self._save(connection, state)
            return self._status(state)

    def select(self, mode):
        if mode not in MODES:
            raise RuntimeErrorBase("invalid_planner_selection")
        with self.store.transaction() as connection:
            state = self._load(connection)
            if mode == "local_model":
                if state.get("invalid") or state["validated_configuration"] is None:
                    raise Conflict("local_planner_validation_required")
                try:
                    self._adapter(state)
                except Exception:
                    raise Conflict("local_planner_validation_required") from None
            repair = state.get("invalid", False)
            if repair:
                state = {**_default_state(), "revision": state["revision"]}
            if state["mode"] != mode or repair:
                state = {**state, "mode": mode, "revision": state["revision"] + 1}
                self._invalidate(connection, state)
                self._save(connection, state)
            return self._status(state)

    def decide(self, goal, evidence, now):
        # The runtime's fresh lease/source/approval guard is mandatory even when
        # this stable facade currently selects its deterministic implementation.
        raise PlannerUnavailable("planner_dispatch_guard_required")

    def record_failure(self, connection=None, claimed_revision=None, *, expected_revision=None):
        """Engine retry hook; persists only a fixed code for the same selection."""
        if expected_revision is None:
            expected_revision = claimed_revision
        with self.store.transaction() as current_connection:
            # Store reuses an existing outer transaction; the parameter is the
            # engine's explicit retry-transaction contract, never a new lock.
            if connection is not None and connection is not current_connection:
                raise ValueError("runtime_transaction_mismatch")
            state = self._load(current_connection)
            if (state.get("invalid") or state["mode"] != "local_model" or state["validated_configuration"] is None
                    or expected_revision is not None and state["revision"] != expected_revision):
                return
            self._save(current_connection, {**state, "last_failure": "model_planner_unavailable"})

    def decide_guarded(self, goal, evidence, now, *, dispatch_precondition, attempt_reservation=None):
        if not callable(dispatch_precondition):
            raise PlannerUnavailable("planner_dispatch_guard_required")
        failure = False
        result = None
        with self.store.transaction() as connection:
            state = self._load(connection)
            revision, key = state["revision"], self._key(state)

            def validate():
                current = self._load(connection)
                if (current.get("invalid") or current["revision"] != revision
                        or current["mode"] != state["mode"] or self._key(current) != key
                        or self.store.settings(connection).get("enabled") is not True):
                    raise PlannerUnavailable("planner_selection_changed")
                dispatch_precondition()

            validate()
            if state["mode"] == "local_model":
                self._consume_attempt(connection, state, attempt_reservation)
            try:
                if state["mode"] == "deterministic":
                    result = self._deterministic.decide(goal, evidence, now)
                else:
                    result = self._adapter(state).decide_guarded(
                        goal, evidence, now, dispatch_precondition=validate)
                validate()
                if state["last_failure"] is not None:
                    self._save(connection, {**state, "last_failure": None})
            except Exception:
                failure = True
                if state["mode"] == "local_model" and not state.get("invalid"):
                    self.record_failure(expected_revision=revision)
        if failure:
            raise PlannerUnavailable("model_planner_unavailable") from None
        return result
