# ADR 0008: Insight Evidence Contract

## Status

Accepted

## Context

Prior L2 planning text proposed a dedicated endpoint:

```text
GET /api/butler/insights/{insight_id}/evidence
```

The current code does not implement that route. Current Butler Inbox evidence details are driven by the fields returned from:

```text
GET /api/butler/insights
```

Each insight card includes inline `evidence_refs`, `evidence_boundary`, confidence, type/status, metrics, and suggested actions.

## Decision

Accept inline `evidence_refs` on insight cards as the current evidence contract.

Do not add a dedicated evidence endpoint during architecture reality alignment.

## Consequences

- Frontend Butler Inbox should expand evidence from the existing insight payload.
- OpenClaw docs should describe `explain_insight_evidence` as reading the relevant insight card from `GET /api/butler/insights`.
- API documentation must explicitly state that `/api/butler/insights/{id}/evidence` is not currently implemented.

## Future

Add `GET /api/butler/insights/{id}/evidence` only if evidence payloads become large, require lazy loading, or need a single-purpose OpenClaw tool contract. That future task must include tests for evidence boundaries, screenshot path-only behavior, and raw-output redaction.
