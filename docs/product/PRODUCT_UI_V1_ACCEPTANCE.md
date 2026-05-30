# Product UI V1 Acceptance

Date: 2026-05-30

## Acceptance Criteria

- The primary navigation has four ordinary entries: Today, Timeline, Butler Chat, and Me/Settings.
- The homepage first screen explains the value of OpenButler without requiring internal technical vocabulary.
- The homepage shows daily status, top reminders, next best action, and timeline entry.
- New users see a three-step guided start instead of empty technical panels.
- Advanced and lab pages remain available behind a folded advanced section.
- Timeline events render like remembered moments with category, source, summary, and expandable basis.
- Reminder cards default to title, summary, status, and action; basis and confidence are expanded only on click.
- Ordinary pages avoid MineContext, godview, PCActivityEvent, InsightCard, and UnifiedTimelineEvent.
- Existing API contracts are preserved.
- Frontend build passes.
- Backend Butler Core and PC Activity tests pass.

## In Scope For V1

- Frontend information architecture.
- User-facing terminology mapping.
- Homepage view-model adapter.
- Timeline view-model adapter.
- Inbox card copy and progressive evidence disclosure.
- Product documentation.

## Out Of Scope For V1

- New backend API routes.
- New evidence endpoint.
- Real MineContext import.
- New hardware integrations.
- External models or webhooks.
- Full visual motion system.
- Removing advanced pages.

## Manual Review Checklist

- First screen reads as a product, not an engineering console.
- Data-insufficient state is clear and non-judgmental.
- The user can find "查看完整时间线".
- The user can expand "查看依据".
- The user can find advanced tools without seeing them as primary navigation.
- Mobile width does not overflow.

## Future Validation

- Run a first-time-user comprehension test.
- Add a browser smoke that asserts ordinary pages do not expose key internal terms.
- Add mobile screenshots for `/butler`, `/timeline`, and `/privacy`.
