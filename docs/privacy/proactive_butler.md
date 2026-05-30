# Proactive Butler Privacy

## Data Used

OpenButler Proactive Butler uses already-authorized local OpenButler data, currently PC Activity events imported from MineContext. It reads structured events, timestamps, app/domain/project labels, confidence, and evidence references.

## Data Not Used

It does not read keyboard logs, passwords, tokens, cookies, or hidden system data. It does not upload MineContext data or screenshots. It does not confirm remote Git, CI, Yunxiao, deployment, or API state.

## Insight Generation

The MVP uses local rules for metrics, focus blocks, context switching, workflow candidates, and data quality notices. It does not use external models. In strict mode external models and webhooks are prohibited.

## Evidence Storage

Insight cards store `evidence_refs` and `evidence_boundary`. Screenshot content is not copied by Butler Core. MineContext screenshot paths remain references only through PC Activity events.

The Butler Inbox evidence detail view follows the same boundary: it may display local evidence refs and screenshot paths as text, but it must not copy screenshot files, read screenshot bytes, run screenshot OCR, or upload screenshot content. If an insight has no evidence refs, the UI must state that the evidence is missing or insufficient instead of making a stronger claim.

## Feedback Loop

User feedback such as useful, dismissed, inaccurate, too frequent, and remind later is stored locally. Repeated dismiss or inaccurate feedback reduces the priority of similar future insights.

## Controls

Users can close proactive insights, disable goals, delete Butler-generated timeline/metrics/insights/briefings/Productization Harness summaries, and keep MineContext untouched. Deleting Butler data does not delete MineContext original data.

The `/goals` page exposes the current retention policy and a guarded deletion control. The control requires typing `DELETE BUTLER` and only deletes OpenButler-derived proactive Butler records: unified timeline events, metric snapshots, insight cards, briefings, and Productization Harness summaries. It does not delete PC Activity events, MineContext source databases, MineContext screenshot files, or external systems.

Default retention policy is local and conservative: derived Butler data is kept for 365 days, insight feedback for 365 days, and Butler audit logs for 90 days unless the user changes settings in a future retention editor.

## Fact Boundary

MineContext generated summaries and OpenButler derived summaries are evidence-backed clues, not final facts. Remote system status must be checked at the source.
