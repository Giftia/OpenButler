# ADR 0009: Design PrivacyGuard Before Implementation

## Status

Accepted

## Context

OpenButler currently enforces privacy through distributed checks in `backend/app/main.py`, PC Activity Context, Butler Core, and Workstation Vision. Those paths are tested and working for the current prototype.

Planning text has repeatedly referred to a unified Privacy Guard, but no central `PrivacyGuard` class exists today. Adding one directly into hot paths without a design pass could break existing strict-mode behavior.

## Decision

Document the future `PrivacyGuard` interface and migration plan before implementing it.

The current behavior remains unchanged. Existing distributed checks stay in place until a separate implementation task adds pure guard functions and proves that they reproduce current decisions.

## Consequences

- Documentation now distinguishes current reality from future architecture.
- Future implementation tasks have a concrete interface and migration order.
- Strict-mode behavior remains protected by existing tests while design work proceeds.
- `PrivacyGuard` must not be claimed as implemented until code and tests exist.

## Future

Implement `backend/app/privacy/guard.py` in small steps:

1. pure decision functions and unit tests,
2. plugin manifest checks,
3. PC Activity import preview checks,
4. Butler Core settings/delete checks,
5. Vision raw-frame checks,
6. contract tests that preserve existing response fields and privacy counters.
