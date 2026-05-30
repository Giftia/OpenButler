# Onboarding Flow

Date: 2026-05-30

## First-Run Goal

Within 10 seconds, a new user should understand:

```text
OpenButler is a local-first AI butler that organizes today's signals,
finds what is worth attention, and keeps the supporting basis inspectable.
```

## Three-Step Start

1. **连接本机观察**
   - User-facing explanation: let OpenButler read authorized local computer activity.
   - UI entry: data source card or advanced/lab link to PC activity context.
   - Privacy note: local read-only by default; no screenshot copy.

2. **生成今日概览**
   - User-facing explanation: organize today's activity into status, reminders, and next actions.
   - UI entry: primary button on the Today page.
   - Privacy note: uses local rules; no external model in strict mode.

3. **查看时间线与依据**
   - User-facing explanation: inspect what was remembered and why a reminder appeared.
   - UI entry: timeline preview or "查看依据" on a reminder card.
   - Privacy note: evidence is shown as references and boundaries, not uploaded data.

## States

### New User / No Data

Show:

- what OpenButler does,
- the three-step start,
- friendly empty state,
- one clear primary action,
- advanced setup entry.

Do not show:

- dense empty tables,
- raw API names,
- internal class names,
- MineContext or godview as first-run terms.

### Connected But No Reminders

Show:

- connected source status,
- timeline access,
- "nothing urgent" message,
- option to generate the daily overview.

### Active Daily Use

Show:

- today status,
- top 1-3 reminders,
- next best action,
- timeline preview,
- evidence access on demand.

### Advanced User

Expose through "高级与实验室":

- raw PC activity page,
- plugin list,
- metrics page,
- goals page,
- vision prototype,
- Productization Harness,
- OpenClaw declarations,
- API diagnostics.

## Follow-Up User Tests

- Can a first-time user explain OpenButler after seeing only the first screen?
- Can a user find where to inspect evidence?
- Can a user tell whether data is real, missing, or demo-only?
- Can a user find advanced diagnostics without seeing them by default?
