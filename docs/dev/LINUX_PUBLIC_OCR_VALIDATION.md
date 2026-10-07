# Linux selected-window / OCR development snapshot

This is an isolated development snapshot, not a production release or a completed
three-platform native-capture implementation. It builds on the separately tested
chat-loop and macOS source-validation snapshot. Publication changes no default
branch, installs no service, deploys nothing and includes no runtime data.

## Implemented scope

- Linux/X11 capture binds one explicitly selected public-only window and fails
  closed on source identity, geometry, expiry, exclusion or processing changes.
- The user explicitly previews masked pixels and starts a bounded session.
  Capture does not start automatically or fall back to a desktop screenshot.
- The explicit OCR-text route performs fresh offline OCR on final masked pixels,
  binds that text to the exact PNG hash, and calls the configured text model.
- Current-only extraction commits before a separate relation-only association
  request, which cannot overwrite its title, summary or evidence boundary
- A bounded single-worker queue preserves pending evidence and exposes failure,
  backpressure, cancellation and explicit retry without automatic replay.
- Keyless local model configuration is RAM-only when that explicit option is
  selected; discovery lists installed model IDs without selecting or downloading.
- The hardware capture-provider interface is a pending extension contract. It is
  not an integrated or verified hardware-capture product.

## Runtime evidence and limitations

A supervised Linux trial established the selected public-window → fresh post-mask
OCR → real local text-model path. A later topic-transition trial exposed a serious
semantic-grounding defect: historical summaries could replace the current
observation despite a changed OCR input. The revised pipeline isolates current
extraction from all historical text and performs association only after current
extraction commits. Historical summaries are preserved as legacy records, not
silently relabeled as corrected results.

Two real extraction calls verified byte-identical history-free request bodies.
A bounded native product transition produced two new version-2 records; the first
skipped association and the second returned an uncertain relation. The committed
current extraction stayed byte-identical while association changed from running
to ready. The native UI rendered legacy and new records together after an
empty-context compatibility fix. Recording was explicitly paused and the trial
runtime stopped.

Semantic quality still fails acceptance: a note about guitar strings was
paraphrased as an observation of physical strings, and generated titles remained
weak. Isolating history fixes the demonstrated contamination mechanism; it does
not establish faithful document attribution or reliable summaries. These results
are model inferences that need review against source evidence. This snapshot is
not ready for unattended everyday recording on that evidence.

No runtime screenshot, original or public-dogfood database, model weight, user
profile, private note, credential, recording or raw trial log is published.

The checked-in `backend/app/modules/context_engine/tests/fixtures/public-window-post-mask-ocr.txt`
is an intentional, reviewed public-test fixture. It is OCR text from an authored
public Qwen evaluation note, with generic document menus and a public model URL.
Its tests pair that text with generated pixels and mocked model responses; they
perform no real window capture or model inference. It must not be described as
evidence that the model's evaluation claims are true.

Lock state is unknown for the dedicated X11 scope and lock protection is not
supported. Samples omit intervening activity. OCR and privacy recognition are
imperfect; managed-memory clearing cannot guarantee removal from OS swap or
crash dumps. Native Windows and macOS capture, real macOS TCC approval/denial,
packaging, signing, notarization and an installer remain separately unverified.
Electron 31.7.7 is an end-of-support preview dependency; this snapshot does not
establish production-security readiness.

## Source-validation boundary

The macOS development workflow uses standard GitHub-hosted public-repository
runners for arm64 and x86_64. It checks the exact source commit, backend synthetic
suites, desktop frontend build and asset paths, UI/native-provider mock contracts,
synthetic offline OCR, and metadata-only native Electron capabilities. It requests
no capture permission, acquires no desktop image and calls no model endpoint.
The X11 suite mocks native calls even when executed on macOS.

For a desktop frontend, run `node desktop/scripts/build-frontend-for-desktop.mjs`
and `node desktop/scripts/check-desktop-frontend-assets.mjs`. A generic frontend
build does not establish correct Electron `loadFile` asset paths. Passing source
or mock tests is not proof of platform-native capture acceptance or model quality.
