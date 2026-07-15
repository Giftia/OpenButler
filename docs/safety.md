# OpenButler Loop Safety

The binding operating rules are in `loop-constraints.md`. This document explains the safety model for humans reviewing loop changes.

## L1

L1 is report-only. It may read tracked governance files, Git refs, and read-only GitHub metadata. It may write only redacted reports below ignored `data/loop-runs/` or GitHub Actions artifacts.

It may not read personal activity, MineContext databases, screenshots, raw audio/video, secrets, or runtime databases. It may not edit code, mutate GitHub, deploy, or contact external models and webhooks.

## L2

L2 remains disabled until the promotion evidence in `LOOP.md` is satisfied. Each change uses one worktree, one maker, and one independent verifier. It opens a PR and requires human merge.

## L3

L3 remains disabled until the verifier, rollback, circuit breaker, privacy invariants, and ten successful L2 fixes are proven. Only documentation, test additions, behavior-neutral copy, and small static-type fixes may eventually auto-merge.

Privacy, identity, consent, sensors, MineContext, Electron lifecycle, dependencies, schemas, migrations, GitHub governance, deployments, and external actions always require human review.

## Stop Conditions

- `loop-pause-all: true` in `STATE.md`.
- Invalid governance YAML.
- Multiple active objectives.
- Unrelated canonical Git history.
- Three consecutive infrastructure failures.
- Any suspected secret or personal-data exposure.

