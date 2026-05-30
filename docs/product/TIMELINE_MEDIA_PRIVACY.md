# Timeline Media Privacy

Updated: 2026-05-30

## Thumbnail Strategy

Timeline V2 supports a right-side thumbnail on every event card, but privacy is prioritized over visual richness.

Display priority:

1. Safe public or app-local image URLs from `thumbnail_url`, `thumbnailUrl`, `media_refs`, or explicitly displayable evidence refs.
2. A non-path placeholder when an event has local screenshot evidence.
3. A source-colored placeholder for demo events or events without media.

## Local Screenshot Paths

The ordinary UI must not display or load local paths such as:

- `C:\Users\...`
- `screenshots\...`
- `raw_ref`
- unredacted screenshot evidence paths

If a local screenshot path is present, the user-facing card only says `有本地截图依据`. The actual path remains hidden from the ordinary timeline surface.

## Demo Media

Demo events use CSS-generated thumbnail placeholders. They should look like evidence slots without pretending to be real user screenshots.

## Boundaries

This round did not read real MineContext data, copy screenshots, upload media, or call external models. It only changes how already-authorized timeline records are presented.
