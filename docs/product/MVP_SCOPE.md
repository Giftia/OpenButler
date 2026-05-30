# MVP Scope

## In Scope

The current MVP is focused on the local PC context and proactive butler loop:

- MineContext PC Activity sensing.
- MineContext godview time query and keyword search.
- PCActivityEvent storage in OpenButler.
- Unified timeline.
- Today metrics.
- Rule-based proactive insights.
- Butler Inbox and insight feedback.
- Morning, evening, and context recovery briefings.
- OpenClaw Skill tools for local context and proactive butler capabilities.
- Strict privacy mode that remains usable without external models.

## Out of Scope

- Full mobile app.
- Acoustic imagers.
- Thermal cameras.
- More USB peripheral integrations.
- Deep smart-home integration.
- Employee monitoring.
- Medical, psychological, personality, or emotion-disorder judgments.
- Cloud-dependent core flows.
- Automatic external writes such as Jira/Yunxiao updates, deployments, commits, or messages.

## MVP Success

The MVP succeeds when this chain is reliable:

```text
MineContext / godview -> OpenButler Adapter -> PCActivityEvent -> Unified Timeline -> Metrics -> Insight Cards -> Briefing -> Feedback
```
