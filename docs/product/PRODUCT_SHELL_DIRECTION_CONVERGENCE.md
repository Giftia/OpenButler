# Product Shell Direction Convergence

Updated: 2026-06-23

## Decision

OpenButler should converge its ordinary-user product shell on the **iOS / Apple Home style private butler** direction.

The formal product should not continue as a design lab, a full technical console, or a pure Mi Home clone. The product identity is:

> 一个安装在本机的私人整理管家。它先给你看样例，再引导你接入本机记录组件和智能整理钥匙。连接后，它每天帮你整理今天发生了什么、什么值得回看、下一步做什么，并且每条建议都能解释依据和边界。

## Why This Direction

### Adopt the iOS / Apple Home direction as the shell

This direction best matches a long-term personal butler:

- quiet enough for daily use;
- clear enough for first-time users;
- suited to one primary action at a time;
- less likely to feel like a developer control surface;
- compatible with a desktop first-run activation path.

### Borrow from the Mi Home direction

The Mi Home-inspired version is useful for scanability, but it should not become the whole product.

Borrow:

- large status numbers;
- grouped scene signals;
- card-based state summaries;
- clear "what changed" surfaces.

Do not borrow:

- device-control density;
- too many first-screen modules;
- the feeling that the product is mainly a signal dashboard.

### Keep the deck direction for commercial storytelling

The PPT/deck direction should remain for pitch, onboarding explanation, and commercial evaluation. It should not be the daily app shell.

## Main Path

The ordinary product path becomes:

1. `今日`: daily command center.
2. `时间线`: life event feed and evidence-backed memory.
3. `成就`: positive progress layer.
4. `问管家`: natural language control layer.
5. `我的`: authorization, privacy, local mode, and preferences.

Technical diagnostics stay under `高级与实验室`.

## Vercel Demo vs Desktop Local Mode

### Public Vercel demo

The public site is a sample experience. It must say:

> 样例体验，未读取你的真实数据。

It should show the product value and setup path, but it must not imply that the hosted web page can read the user's computer.

### Desktop local mode

The desktop app is the real personal-data product path. It should guide the user through:

1. See a sample.
2. Install or open the desktop app.
3. Create or paste the 智能整理钥匙.
4. Enable the 本机记录组件.
5. Preview what OpenButler will read.
6. Confirm before any real organization begins.

## First Minute Standard

Within the first minute, a new user should know:

- what OpenButler is;
- whether they are seeing sample data or real local mode;
- what they will get after setup;
- what they need to configure next;
- that they can inspect evidence and boundaries later.

## Required Follow-Up Issues

1. `OB-UI-001`: converge `/design/ios` into the formal `/butler` homepage.
2. `OB-UI-002`: bring Mi Home-style key numbers and scene signals into that homepage.
3. `OB-ACT-001`: rebuild first-run activation as a non-skippable path choice.
4. `OB-ACT-002`: add "where do I get an API key?" help to model provider setup.
5. `OB-LOCAL-001`: replace ordinary MineContext language with 本机记录组件.
6. `OB-DESK-001`: verify desktop install, tray, backend lifecycle, and uninstall cleanup.
7. `OB-TRUST-001`: unify evidence wording across Today, Timeline, Inbox, Assistant, and Achievements.
8. `OB-GOV-001`: update current state, goals, and task queue after direction convergence.

## What Not To Do

- Do not add a fourth design style.
- Do not keep optimizing the old home page without choosing a direction.
- Do not expose MineContext, PCActivity, raw source fields, or screenshot paths in ordinary UI.
- Do not imply the public web demo reads local data.
- Do not run real MineContext import or 7-day review as part of this product-shell convergence.
- Do not add new hardware or new external data sources.

## Acceptance Criteria

- The repository has one active product-shell direction.
- `/design/ios` is declared the formal homepage candidate.
- Mi Home and deck directions have clear roles.
- Ordinary setup language uses 本机记录组件 and 智能整理钥匙.
- Follow-up work is split into independently executable issues.

