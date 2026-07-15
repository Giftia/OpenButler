---
name: loop-triage
description: Run OpenButler's read-only repository governance drift audit and summarize evidence without changing product code, GitHub state, deployments, or personal data.
user_invocable: true
---

# OpenButler L1 Governance Triage

1. Read `loop-constraints.md`, `loop-budget.md`, `LOOP.md`, and `STATE.md`.
2. Exit immediately if `loop-pause-all: true`.
3. Run:

```powershell
Push-Location tools/loop
npm run audit:governance -- --github
Pop-Location
```

4. Interpret exit codes:
   - `0`: clean;
   - `2`: actionable drift;
   - `3`: partial evidence or circuit breaker.
5. Report high-priority findings, watch items, unavailable evidence, and the ignored report path.

## Hard Rules

- Do not edit tracked files, including `STATE.md` and `loop-run-log.md`.
- Do not create, label, comment on, or close GitHub issues or pull requests.
- Do not create branches, commits, deployments, notifications, or automations.
- Do not run Productization Harness endpoints because they may write local audit data.
- Do not read MineContext, local databases, screenshots, microphone data, camera data, or raw activity output.
- Do not spawn sub-agents in L1.
- If no drift exists, stop without broader code analysis.

## Output

Use concise Chinese. Never include secret values, activity titles, URLs, screenshot paths, or personal data.
