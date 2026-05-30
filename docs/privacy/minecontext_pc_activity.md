# MineContext PC Activity Privacy

## What OpenButler Reads

- MineContext activity records, timestamps, titles, summaries, resources, and screenshot paths.
- MineContext godview query/search JSON output.
- Optional observation pack text as local context.

## What OpenButler Does Not Read

- Keyboard-by-keyboard logs.
- Passwords, verification codes, tokens, cookies, or browser secrets.
- Screenshot image content through cloud OCR.
- Remote system truth such as Git, CI, Yunxiao, or production API status.

## Default Storage

- Stores normalized PC activity events in OpenButler SQLite.
- Stores screenshot paths by default for local evidence review.
- Does not copy screenshot files by default.
- Does not upload MineContext data or screenshots.

## Strict Mode

Strict mode disables external model calls, external webhooks, and screenshot copying. MineContext access remains local and read-only. Raw godview output is discarded by default, and sensitive-looking text is redacted before storage.

## Basic Mode

Basic mode may allow explicitly authorized external integrations elsewhere in OpenButler, but MineContext PC activity still defaults to read-only local access and path-only screenshot evidence.

## Disable, Delete, Export

- Disable: turn off MineContext access in the PC 操作感知 page or `POST /api/pc-activity/settings`.
- Delete imported events: `DELETE /api/pc-activity/events`.
- Export: use `GET /api/pc-activity/events` and `GET /api/pc-activity/summary/today` for structured local data.

## Fact Boundary

MineContext is a local observation source. Its generated summaries can be wrong or incomplete. OpenButler must label low-confidence or generated-text-only matches as hints and must ask the user to verify remote systems at the source when needed.
