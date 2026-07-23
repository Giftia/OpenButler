# OpenButler Loop Budget

## L1 Daily Limits

| Property | Limit |
|---|---:|
| Runs per weekday | 1 |
| Hard token cap | 100,000 |
| Expected blended use | 23,000 |
| No-op target | 5,000 or less |
| Wall time | 5 minutes |
| Files inspected | 25 |
| GitHub read calls | 20 |
| Sub-agents | 0 |
| Product mutations | 0 |

## Throttle

- At 80 percent of the daily token cap, remain report-only and stop optional checks.
- At 100 percent, exit and record a budget escalation for human review.
- When no actionable change is found, exit before broad code inspection.
- Retry only GitHub 429 or 5xx failures, at most twice with backoff.

## Cost Check

```powershell
npx @cobusgreyling/loop-cost@1.1.0 --pattern daily-triage --level L1
```

## Future Levels

- L2 nightly hard token cap is 750,000, with no new issue started after 600,000 tokens or 06:15 Asia/Shanghai.
- L2 may run one maker and one independent verifier per item, strictly serially.
- An individual issue may consume at most 160,000 tokens before escalation.
- L2 has no fixed issue-count limit; time, token, privacy, CI, and verifier circuit breakers are authoritative.
- L3 budgets are not defined until the L2 promotion gate is satisfied.
