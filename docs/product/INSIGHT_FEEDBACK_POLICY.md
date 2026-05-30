# Insight Feedback Policy

This document defines the L2 feedback-driven noise reduction policy for Proactive Butler Core.

## Goal

OpenButler should become less noisy after user feedback without hiding important privacy, safety, or data-quality notices. The policy is local, rule-based, and does not call external models.

## Feedback Types

- `useful`: the insight was helpful.
- `accepted_action`: the user accepted or acted on the suggestion.
- `dismissed`: the user ignored the insight.
- `not_useful`: the insight was not helpful.
- `inaccurate`: the insight was wrong or overconfident.
- `too_frequent`: the insight type appears too often.
- `remind_later`: the user wants a temporary snooze.

## Scoring Rules

- Repeated `dismissed` or `not_useful` feedback lowers the priority of the same insight type after `reduce_priority_after_dismiss_count`.
- `too_frequent` lowers the priority of the same insight type immediately and adds a cooldown signal.
- Repeated `inaccurate` feedback suppresses non-protected insight types after `disable_type_after_inaccurate_count`.
- `useful` and `accepted_action` increase the priority of the same insight type up to `max_positive_priority_boost`.
- The adjustment is written into each generated insight under `metrics.feedback_adjustment` so users and tests can inspect why priority changed.

## Protected Notices

The following insight types are protected from permanent suppression:

- `data_quality_notice`
- `privacy_notice`

They may be lowered in priority or cooled down, but they must not disappear permanently because they prevent fabricated conclusions and privacy boundary violations.

## Evidence Boundary

Feedback scoring only uses local OpenButler feedback rows and insight types. It does not inspect MineContext source databases, screenshot bytes, raw godview output, remote repositories, CI, Yunxiao, deployments, or online services.

## Privacy Boundary

The feedback policy must keep:

- `external_model_used: false`
- `external_webhook_used: false`
- no system notification by default
- no MineContext source mutation
- no screenshot copying

## Evaluation Report

The L2 evaluation endpoint is:

```http
GET /api/butler/insights/noise-evaluation
```

It returns per-insight-type feedback counts, priority delta, cooldown minutes, suppression recommendation, protected notice status, reason codes, privacy counters, and evidence boundary.
