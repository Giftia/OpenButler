# ADR 0011: Use loop-engineering as the development control plane

## Status

Accepted on 2026-07-15.

## Context

OpenButler had goals, a task queue, tests, and productization reports, but their state could drift across long prompt-driven sessions. The repository also lacked a persistent, budgeted maker/checker operating contract.

## Decision

Use loop-engineering primitives for repository triage, durable state, budgets, constraints, worktree isolation, independent verification, and explicit human gates. Begin at L1 report-only and promote only with measured evidence.

GitHub Issues are the executable queue. `.openbutler/goals.yaml` remains the product-goal authority. `STATE.md` stores current loop state. `current_state.md` is orientation, not live queue state.

## Consequences

- Automated development starts slower but has explicit authority and failure boundaries.
- L1 cannot repair drift; it only reports it.
- L2 and L3 require separate promotion evidence.
- Privacy, identity, sensors, dependencies, APIs, desktop lifecycle, and external actions always retain human review.
