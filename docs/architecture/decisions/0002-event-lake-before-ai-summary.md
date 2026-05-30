# 0002 Event Lake Before AI Summary

## Status

Accepted.

## Context

AI summaries are useful but can omit, hallucinate, or overstate details.

## Decision

OpenButler stores evidence-preserving structured events before generating summaries or insights.

## Consequences

- Every insight should reference source events.
- Generated text is a view over evidence, not the data model.
- Rebuilding metrics or briefings from the event lake should remain possible.
