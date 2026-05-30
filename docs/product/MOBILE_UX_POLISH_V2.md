# Mobile UX Polish V2

Date: 2026-05-30

## Feedback Summary

The hosted mobile demo is closer to a product than the earlier technical console, but the first screen still asks too much from ordinary users.

Observed issues:

- the mobile top navigation uses large card-like buttons and consumes too much first-screen height,
- the home page repeats similar counters before the user reaches actual suggestions,
- timeline demo records still contain developer wording,
- chat demo answers can expose internal source names,
- the My page opens with architecture language instead of ordinary privacy and data settings,
- some secondary buttons look too pale and can be mistaken for disabled controls.

## V2 Direction

The first mobile screen should show:

- what OpenButler is doing,
- what has been organized today,
- one primary action,
- a clear demo-data boundary.

The ordinary path is:

```text
Today -> Butler suggestions -> Timeline -> Evidence -> My settings
```

The advanced path is:

```text
My -> Advanced & Lab -> plugin/runtime/API/deployment diagnostics
```

## Acceptance

- The mobile nav is compact and no longer dominates the first screen.
- The home hero combines product value, today's summary, demo/local status, and one primary action.
- Demo records read like natural Chinese life records.
- Ordinary UI does not show `phone_album`, `seed`, `Provider`, `Webhook`, raw source names, or English demo logs.
- The My page starts with privacy, data source, demo mode, and preference controls.
- Advanced architecture details remain discoverable under a collapsed lab section.
- Build and core backend tests pass.

## Out Of Scope

- No new hardware or data sources.
- No real MineContext read or seven-day import.
- No external model call.
- No new backend evidence endpoint.
- No directory migration.

