# 0004 Strict Privacy Mode

## Status

Accepted.

## Context

OpenButler's target data is sensitive and should be useful without leaving the user's machine.

## Decision

Strict mode forbids external models, external APIs, external webhooks, default screenshot copying, and silent notifications.

## Consequences

- Plugins must declare privacy and model requirements.
- Strict-compatible features should be prioritized.
- External calls require basic mode plus explicit user authorization.
