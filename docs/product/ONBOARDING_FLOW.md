# Onboarding Flow

Date: 2026-05-30

Updated: 2026-06-04 for OB-GOAL-011 First-Run Activation Flow.

## First-Run Goal

Within 10 seconds, a new user should understand:

```text
OpenButler is a local-first AI butler that organizes today's signals,
finds what is worth attention, and keeps the supporting basis inspectable.
```

## Three-Step Start

First-run activation now starts with a choice, not a technical setup screen:

1. **先看样例**
   - User-facing explanation: understand the product without reading real data.
   - UI behavior: set local browser activation state to `demo_selected`.
   - Privacy note: no real MineContext data, screenshots, uploads, external models, or backend imports.

2. **连接本地数据源**
   - User-facing explanation: enter real local setup when the user is ready to authorize data.
   - UI behavior: route to the existing local data source / PC activity setup path.
   - Privacy note: this CTA does not directly import or mutate data.

3. **稍后配置**
   - User-facing explanation: enter the product with a clear next step and no empty console.
   - UI behavior: set local browser activation state to `dismissed`.
   - Privacy note: no real data is read.

After the choice, the product-level promise is still:

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
- the sample-vs-real choice,
- what the user gets after connecting,
- the three-step start,
- friendly empty state,
- one clear primary action,
- advanced setup entry.

Do not show:

- dense empty tables,
- raw API names,
- internal class names,
- MineContext or godview as first-run terms.

The home page should prefer:

- primary action: `先看样例`,
- secondary action: `连接本地数据源`,
- quiet action: `稍后配置`.

It must not directly run a real import from the first-run prompt.

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

## Local Activation State

The browser-local activation key is:

```text
openbutler:first_run_activation:v1
```

Allowed values:

- `unseen`
- `demo_selected`
- `real_setup_started`
- `dismissed`
- `completed`

This state is a UI preference only. It is not a backend account state and must not be treated as authorization to read local data.

## Follow-Up User Tests

- Can a first-time user explain OpenButler after seeing only the first screen?
- Can a user find where to inspect evidence?
- Can a user tell whether data is real, missing, or demo-only?
- Can a user find advanced diagnostics without seeing them by default?
