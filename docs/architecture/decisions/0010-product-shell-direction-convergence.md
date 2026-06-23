# ADR 0010: Product Shell Direction Convergence

Date: 2026-06-23

## Status

Accepted

## Context

OpenButler has accumulated multiple working product surfaces: Today, Timeline, Achievements, Assistant, My OpenButler, Inbox, desktop activation, and design experiments.

Recent neutral-user reviews showed a repeated problem: users could see many capabilities, but they still struggled to understand the product as one coherent personal butler. The team then added three parallel design variants:

- Mi Home-style state console;
- iOS / Apple Home-style private butler;
- deck/PPT-style commercial presentation.

Continuing to optimize all variants equally would keep the project in prototype drift.

## Decision

OpenButler will converge the ordinary-user product shell on the **iOS / Apple Home-style private butler** direction.

The Mi Home direction will contribute key-number cards, scene signal grouping, and scan-friendly status surfaces.

The deck/PPT direction will remain for commercial storytelling, onboarding explanation, and pitch material.

## Consequences

- `/design/ios` becomes the formal homepage candidate for `/butler`.
- `/design/mijia` remains an ingredient source, not the full shell.
- `/design/deck` remains a storytelling artifact, not the daily app.
- Future UI work should not create another parallel homepage style unless this ADR is explicitly reopened.
- Ordinary-user language should use "本机记录组件" and "智能整理钥匙"; implementation names such as MineContext belong in advanced details.

## Alternatives Considered

### Keep refining the existing `/butler` page

Rejected. The existing page has improved, but it still carries earlier control-panel assumptions and has repeatedly pulled work into local layout fixes.

### Make Mi Home the formal shell

Rejected as the full shell. It is useful for status data, but too easily reads as a device dashboard rather than a patient personal butler.

### Make the deck version the formal shell

Rejected. It is strong for pitching the concept, but too theatrical for a daily-use desktop product.

