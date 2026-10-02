# 0.2.0 Preview: Built-in Recording to Daily Review

Approved scope, 2026-09-22: install the isolated Preview, configure image and
text models, authorize one display, record, then review an evidence-backed
timeline and daily summary without installing MineContext.

## Delivery gates

1. OB-GOAL-034 / #24-#27: foundation, loopback authentication and Origin
   restrictions, central privacy decisions, redacted status and audit.
2. OB-GOAL-035 slice: independent image/text routes, custom/local endpoints,
   write-only secrets and atomic validated configuration. Embedding is deferred.
3. OB-GOAL-036 slice: Electron capture, application exclusions, masks, local OCR
   redaction, change detection, resumable processing and seven-day retention.
4. Reuse the current product shell for timeline, daily review and evidence;
   replace the external-component setup path; deliver a packaged Preview.

Only OB-GOAL-034 is active. Foundation files or a passing status check do not
prove a complete product, successful capture, model processing, or installation.
Each stage needs tests and independent review. Existing automatic schedules and
automatic merging stay paused; this is an interactive implementation.

## Privacy defaults

- Capture requires an explicit start, one chosen display, and a 60-second
  interval. Lock/sleep/pause stops new capture; resume requires the user.
- Exclude applications before capture. An unknown foreground application means
  skip, not capture. Support fixed masks and local OCR-based sensitive text masks.
- Keep the original frame in memory only. Persist masked evidence and derived
  records for seven days by default; permit earlier deletion.
- External endpoints are opt-in. Bind consent to endpoint, purpose and data
  scope after a preview of masking. Redaction failure means no send.
- Explain that masking cannot discover every sensitive item. Revocation stops
  new requests but cannot undo a request already delivered to a model endpoint.
- Use synthetic data in development. Never reuse old automation authorization
  for sending real records. Do not read old MineContext data.

## Result contract

Show only the interval actually observed. Every summary references recorded
evidence; missing data is not inactivity, and remote facts remain unconfirmed.
Model failure means recorded-but-not-processed with a recovery action. Real mode
never silently substitutes demo data. Expired media is an explicit state.

## Acceptance

- Fresh Windows install without Python or MineContext can complete setup.
- A synthetic 30-minute workflow yields timeline and daily review. With valid
  models and sufficient records, the first processed item appears within five
  minutes; failures are explicit.
- Test consent, exclusions, redaction failure, revocation, timeout, offline,
  restart idempotency, retention, tray, relaunch and process cleanup.
- Run available backend regressions, frontend build/browser checks, desktop
  contracts and packaged smoke. Report synthetic and real acceptance separately.
- Ship `0.2.0-preview.<date>.<sequence>` with isolated identity and data; do not
  replace stable. No task/search/memory parity, billing or hardware in this slice.

## Checkpoint

Updated 2026-09-23 in the isolated `codex/preview-020-foundation` worktree:

- #24-#27 foundation is implemented locally: session-bound loopback API, Origin
  restrictions, shared PrivacyGuard, metadata-only audit and redacted status.
  OB-GOAL-034 remains active; the broader migration and external-action guard
  is not complete and must not be reported as proven.
- The Preview desktop channel now has one-display capture, explicit masked
  preview and confirmation, 60-second checks, foreground application exclusion,
  offline OCR, fixed/sensitive-text masking, change deduplication, pause on lock
  and sleep, opaque image evidence, and seven-day retention of owned records.
  Restart never resumes recording. Tray text reflects recording state.
- Image and text routes are independent, use synthetic image/text connection
  probes, and activate as a pair only after both succeed. Windows safeStorage
  protects the saved configuration; GET never returns API keys. Local and
  custom endpoints are supported. Custom endpoints require separate external
  call and masked-data consent. No real model was called in development.
- Today and Timeline display only the built-in records, their observed time
  range, state, masked evidence and uncertainty. Failure and expiry are explicit;
  users can retry a failed record or delete an owned record early. The today's
  overview is bounded by the most recent 100 fetched records, not a claim of
  complete historical coverage.
- A synthetic accelerated 30-minute sequence passed. The final isolated
  installer is `0.2.0-preview.20260923.3`; its unpacked packaged app passed
  startup, desktop bridge, strict backend, offline OCR resource and exit
  cleanup checks. A browser smoke covered activation, privacy preview,
  pause/revoke, timeline and opaque evidence. The existing Preview installation
  was upgraded by the standalone Preview installer. The installed app then
  passed the same smoke with an isolated test profile; stable installation
  and existing Preview user data were not used by the smoke. Uninstall
  lifecycle remains unverified. This is not an actual 30-minute unattended run, a
  real-screen privacy validation, a real model connection, or an installed-app
  acceptance. Model settings restored after restart show only nonsecret fields
  and require revalidation before use.

Known limits: OCR can miss sensitive content; the preview is a necessary
human check but cannot prove future frames are fully redacted. Mask coordinates
are numeric, not yet a visual drag tool. A failed record cannot be retried after
its masked image has expired. OpenButler does not infer activity during gaps.
Existing MineContext data was not read or modified, and no stable installation
or Vercel deployment was changed in this worktree.
