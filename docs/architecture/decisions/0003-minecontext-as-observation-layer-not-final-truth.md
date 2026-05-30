# 0003 MineContext As Observation Layer Not Final Truth

## Status

Accepted.

## Context

MineContext observes local PC activity and can produce summaries, screenshots paths, and semantic context. It cannot prove remote system state.

## Decision

OpenButler treats MineContext as a local observation layer and evidence source, not a final fact authority.

## Consequences

- Query answers must include evidence boundaries.
- Remote facts such as deployments, CI status, Yunxiao task state, repository state, or service health require source-system verification.
- Generated MineContext reports are lower-confidence clues unless backed by direct activity records or screenshot paths.
