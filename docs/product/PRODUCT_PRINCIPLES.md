# Product Principles

OpenButler is a proactive full-context AI butler. Its job is to help the user make daily life clearer, more efficient, and more measurable.

## Principles

1. **Proactive full-context butler**: OpenButler should surface what matters without requiring the user to ask every time.
2. **Clarity, efficiency, measurability**: every feature should help the user understand what happened, decide what matters, or quantify progress.
3. **Local-first**: personal context starts on the user's machine and should remain local whenever possible.
4. **User-controlled**: data sources, analysis, retention, notifications, and external actions require visible user control.
5. **Evidence-chain first**: insights must keep source references, confidence, and evidence boundaries.
6. **Generated text is not final truth**: MineContext summaries, LLM summaries, and second-order reports are clues, not authoritative facts.
7. **Proactive but not noisy**: OpenButler should be useful before it is frequent.
8. **Quantitative but not judgmental**: metrics describe behavior; they do not shame the user.
9. **Helpful without anxiety**: suggestions should be mild, reversible, and non-catastrophic.
10. **Extensible data sources**: MineContext is the first strong sensing layer; other sources must use adapters and standard events.
11. **Plugin architecture**: preprocessing, timeline, and tool plugins should declare permissions and privacy requirements.
12. **OpenClaw-first integration**: useful context and butler capabilities should be callable by OpenClaw/Codex through explicit tools.

## Product Test

A feature belongs in OpenButler when it strengthens this loop:

```text
authorized local signal -> evidence-preserving event -> unified timeline -> metric -> insight -> user feedback -> better next suggestion
```
