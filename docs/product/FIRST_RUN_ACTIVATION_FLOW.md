# First-Run Activation Flow

Date: 2026-06-04

## Goal

New users should understand within 30 seconds:

- OpenButler is a private AI butler that organizes authorized local signals.
- Sample mode is only a product preview and does not read real local data.
- Real local mode requires explicit user authorization.
- After connecting a data source, the user gets a daily overview, timeline, butler reminders, and inspectable basis.

## Scope

This version is a frontend activation experience. It does not add backend APIs, OAuth, operating-system permissions, new data sources, or real MineContext imports.

## Activation States

The frontend stores the first-run state in:

```text
openbutler:first_run_activation:v1
```

Allowed values:

- `unseen`: first visit, show activation flow.
- `demo_selected`: user chose sample mode.
- `real_setup_started`: user chose to connect a local data source.
- `dismissed`: user chose to configure later.
- `completed`: user acknowledged the explanation.

The state is local to the browser. It is not written to the backend and does not trigger real data import.

## Flow

### 1. Understand The Product

Copy should explain:

```text
OpenButler 会整理你主动授权的本地线索，生成今日概览、管家提醒和可复核依据。
```

Do not start with internal module names, API names, or data model terminology.

### 2. Choose How To Start

Primary choices:

- `先看样例`: enters sample mode and shows product value without reading real data.
- `连接本地数据源`: navigates to the existing local data source setup path.
- `稍后配置`: enters the home page with clear next steps instead of an empty console.

### 3. Explain What The User Gets

The result cards must explain:

- `今日概览`
- `管家提醒`
- `可复核依据`

The preview can show sample life records, but must mark them as sample data.

## Sample Mode

Sample mode can use frontend fallback records to show:

- a possible object-location reminder,
- a follow-up reminder,
- a gentle rhythm suggestion,
- a short timeline preview.

Sample mode must not:

- read real MineContext data,
- copy screenshots,
- upload data,
- call external models,
- present sample content as real user history.

## Real Local Mode

The activation CTA routes to the existing local data source setup page. It is only a path explanation in this version; it does not automatically import activity or read local files.

User-facing copy should say:

```text
真实本地模式需要你主动授权。连接后，OpenButler 会开始整理今日概览、时间线、管家提醒和依据。
```

## My Page Entry

`/me` should expose a plain-language setup area:

- current state,
- sample mode status,
- real local mode status,
- what the user gets after connecting,
- reopen activation flow.

Advanced implementation details stay inside `高级与实验室`.

## Acceptance

- First visit to `/butler` shows the activation flow.
- `先看样例` closes the flow and shows sample value without backend import.
- `连接本地数据源` navigates to the existing local data source setup path.
- `稍后配置` closes the flow and leaves a friendly next step.
- `/me` can reopen the activation flow.
- Ordinary UI avoids `MineContext`, `PCActivity`, `mock`, `seed`, `Provider`, and `Webhook`.

## Verification

Frontend smoke command:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\frontend
npm run smoke:first-run-activation
```

The smoke opens a Chromium-compatible browser in a mobile-sized window and verifies:

- first-run activation appears on `/butler`,
- `先看样例` persists sample mode and shows product value,
- `连接本地数据源` routes to the existing setup path,
- `稍后配置` leaves a clear next step,
- `/me` can reopen the activation flow,
- `scrollWidth <= viewportWidth` throughout the flow.
