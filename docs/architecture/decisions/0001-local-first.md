# 0001 Local First

## Status

Accepted.

## Context

OpenButler handles highly personal context: PC activity, screenshots paths, visual sensing, notes, and future household signals.

## Decision

OpenButler is local-first. Core value must work on a self-hosted local deployment, and strict mode must not require external models or webhooks.

## Consequences

- SQLite is acceptable for the MVP.
- External providers must be optional.
- Source adapters should prefer local APIs, scripts, or read-only local data.
- Product quality must not depend on cloud-only summaries.
