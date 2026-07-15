# Privacy Boundaries

This document is the repository-level privacy boundary for OpenButler.

Implementation note: privacy enforcement is currently distributed across backend modules. `docs/architecture/PRIVACY_GUARD_DESIGN.md` describes a future unified PrivacyGuard, but no central guard implementation exists yet.

## Strict Mode

Strict mode forbids:

- external model calls,
- cloud API calls,
- external webhooks,
- automatic screenshot copying,
- automatic external writes,
- hidden monitoring,
- third-party or employee monitoring use.

Strict mode must remain useful for MineContext PC activity, unified timeline, metrics, rule-based insights, Butler Inbox, and briefings.

## MineContext Data

OpenButler reads authorized local MineContext data through adapters. Defaults:

- local read-only access,
- no mutation of MineContext source data,
- no deletion of MineContext source data,
- no screenshot copying,
- screenshot paths may be stored as evidence refs,
- raw godview output is not stored unless explicitly configured.

Repository defaults do not contain a personal workspace path. Runtime paths are derived from the current operating-system profile or explicit local configuration. MineContext health responses expose only whether workspace and data-directory settings are configured; they do not return local absolute paths.

## PC Activity Import Preview

The L2 recent-history import preview is dry-run by default and must remain non-mutating:

- it does not write OpenButler PC Activity events,
- it does not modify or delete MineContext source data,
- it does not copy screenshot files,
- it does not upload screenshot paths or PC activity summaries,
- it does not call external models,
- it does not call external webhooks,
- it reports estimated source events, estimated new events, estimated duplicates, warnings, and an evidence boundary.

The preview endpoint rejects non-dry-run requests. A future real import path must keep MineContext read-only and must separately prove idempotent upsert behavior before it is enabled.

## Vercel Demo Mode

When `OPENBUTLER_DEPLOY_TARGET=vercel` or `OPENBUTLER_ENABLE_DEMO_DATA=1`, OpenButler may seed synthetic demo-only PC Activity events so the hosted prototype can show the full Butler experience without a user's private MineContext data. These records:

- are generated only when OpenButler's PC Activity table is empty,
- are marked as demo-only shareable summaries,
- do not read, copy, upload, mutate, or delete MineContext source data,
- contain no screenshot paths or screenshot content,
- do not call external models or external webhooks.

Demo mode is for product experience validation. It must not be represented as real user history.

## Notifications and External Writes

OpenButler does not send system notifications by default. It does not write to external systems by default. Any future external write must be presented as a draft and require user confirmation.

## User Rights

Users must be able to:

- turn off integrations,
- delete OpenButler-derived events and insights,
- export structured OpenButler data,
- change retention settings,
- mark insights inaccurate or too frequent.

Structured Butler export includes OpenButler-derived timeline, metrics, insights, briefings, goals, Productization Harness summaries, and settings. It must not include MineContext source databases, raw godview output, copied screenshots, screenshot bytes, screenshot content, or external-system state.

Butler data deletion controls must clearly state their scope. Deleting proactive Butler data removes only OpenButler-derived unified timeline events, metric snapshots, insight cards, briefings, and Productization Harness summaries. It must not delete PC Activity events, MineContext source databases, MineContext screenshot files, or external-system data.

## Insight Boundaries

Every proactive insight must include an evidence boundary. OpenButler must state when data is incomplete or cannot confirm a remote fact.

## Forbidden Inferences

OpenButler must not produce:

- medical diagnosis,
- psychological diagnosis,
- personality judgment,
- intelligence judgment,
- emotion-disorder judgment,
- moral judgment about entertainment or rest,
- evaluation of third parties without authorization.

## Generated Text

MineContext summaries, LLM summaries, reports, tips, and semantic hits are clues. They are not final truth. Direct activity records and evidence references have higher weight, but remote facts still require source-system verification.
