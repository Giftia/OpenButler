# Timeline Event Feed V2

Updated: 2026-05-30

## Purpose

Timeline V2 turns `/timeline` from a record-card list into a scan-friendly event feed. The page should answer "what happened" before it exposes when, where, or how the conclusion was produced.

## Information Hierarchy

Each event card uses this order:

1. Event title: the main visual focus.
2. Event summary: one natural-language explanation.
3. Thumbnail: a right-side visual evidence cue.
4. Time: a weak left-side index.
5. Source, tag, and evidence availability: subdued chips.
6. Evidence and boundary: progressively revealed only when the user asks.

This deliberately weakens time and source because ordinary users browse the timeline to understand events, not to inspect backend records.

## User-Facing Event Copy

Technical event names are converted before display:

- `focus_block` -> `一段专注被记住了`
- `context_switch` -> `有一段切换值得注意`
- `workflow_candidate` -> `一个流程可能值得自动化`
- `data_quality_notice` -> `有些数据还不完整`
- English demo logs are rewritten as short Chinese life-record copy.

The ordinary UI must not expose `PCActivityEvent`, `UnifiedTimelineEvent`, `source_event_id`, `raw_ref`, or `evidence_refs`.

## Scope

This round changes the frontend ViewModel and UI only. It does not read real MineContext data, copy screenshots, call external models, or add backend API routes.
