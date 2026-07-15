# ADR 0012: Use a Windows laptop as the first ambient reference device

## Status

Accepted on 2026-07-15.

## Context

The long-term product direction includes persistent environmental context and timely assistance. Building dedicated screenless hardware before the privacy, identity, power, and silence policies are proven would multiply risk.

## Decision

Use the existing Windows desktop product and laptop camera, microphone, speaker, screen, power state, and authorized PC context as the first reference environment. Screen output is the default; voice is opt-in and restricted.

## Consequences

- Power and lock-state integration are first-class requirements.
- Sensor indicators must remain visible in the tray and application.
- Multi-user household consent and unknown-person fallback are designed before private voice output.
- Dedicated hardware and smart-home execution remain blocked until the first laptop ambient loop is reliable.

