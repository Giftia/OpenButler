# Loop-Driven Ambient OpenButler Architecture

Updated: 2026-07-15

## Two Loops, Two Authorities

OpenButler uses two deliberately separate loops.

### Development Control Loop

```text
Schedule -> repository triage -> durable state -> isolated worktree
         -> maker -> independent verifier -> PR -> human or allowlisted gate
```

This loop manages development. L1 is report-only. It has no authority over personal data, sensors, deployments, or GitHub mutations.

### Ambient Product Loop

```text
SensorObservation
  -> EventEnvelope
  -> IdentityClaim + ConsentGrant
  -> Context Fusion
  -> InterventionDecision
  -> silent | inbox | desktop | voice | ActionProposal
  -> feedback
  -> local policy and memory update
```

This loop is product runtime behavior. It is not enabled by the development loop and must pass goals 028 through 032 before external actions are considered.

## Reference Device

The first reference device is a Windows laptop using its existing screen, camera, microphone, speaker, power state, and PC activity context. Dedicated screenless hardware is out of scope until one laptop ambient loop is reliable and trusted.

## Domain Contracts

### SensorObservation

An ephemeral local fact from a sensor or authorized software source. It includes source, observed time, confidence, retention class, and whether raw material exists. Raw audio and video are not persisted by default.

### EventEnvelope

The normalized durable event. It uses a stable source ID and includes household, member or unknown subject, zone, time range, confidence, evidence boundary, consent scope, and privacy level.

### IdentityClaim

A local claim that the subject is an explicitly enrolled household member or `unknown`. It records confidence, recognition method, and mixed-occupancy state. Low confidence always becomes `unknown`.

### ConsentGrant

Defines who authorized which source, for what purpose, retention period, and output channels. Revocation must stop affected processing within one sampling cycle.

### InterventionDecision

The result of the silence policy. Allowed channels are `silent`, `inbox`, `desktop`, `voice`, and `proposal`. It records reason codes, confidence, cooldown state, daily budget state, and evidence references.

### ActionProposal

A non-executed action request with risk class, source-system verification requirement, approval state, and rollback strategy. The future state machine is `proposed`, `approved`, `running`, `succeeded`, or `failed`.

## Planned Local Interfaces

The following interfaces belong to later goals and are not implemented by OB-GOAL-027:

```text
GET  /api/ambient/status
GET  /api/household/members
POST /api/household/consents
GET  /api/interventions
GET  /api/privacy/activity
```

They must not expose raw audio/video, biometric templates, API keys, screenshot paths, local file paths, or MineContext raw text.

## Sensor Policy

- Audio standby uses local voice activity, wake, and coarse acoustic classification only. Any raw ring buffer is memory-only and capped at roughly five seconds.
- Camera sampling starts with low-rate presence detection. Identity runs only after explicit enrollment and primarily on state changes.
- Lock, sleep, lid close, battery saver, or user pause lowers or stops sampling.
- Tray and application surfaces continuously show microphone and camera status.
- Optional cloud understanding may receive only explicitly approved, redacted summaries. Strict mode remains fully local.

## Household Safety

- Roles are owner, adult, child, guest, and unknown.
- Automatic recognition requires prior explicit enrollment.
- Enrollment media is deleted after local encrypted templates are produced.
- Private content is not spoken when multiple people or an unknown person are present.
- Children, guests, and unknown people receive more restrictive defaults.

## Silence Policy

Before intervening, OpenButler checks consent, identity confidence, quiet hours, cooldown, daily intervention budget, duplicate pending reminders, actionable value, and remote-fact verification needs.

Default priority:

```text
silent > inbox > desktop > opt-in voice > action proposal
```

## First Ambient Slice

After goals 028-031, the first slice uses synthetic evidence: approximately 90 minutes of workstation presence plus stable PC context produces at most one evidence-backed break or wrap-up suggestion. It enters Inbox by default. Restart must not duplicate it, and feedback must affect future frequency.

## Metrics

Primary metric:

```text
trust-adjusted useful intervention rate
= (useful feedback + accepted actions) / delivered interventions
```

Hard guards are zero unauthorized transfers, zero high-risk identity misattributions, zero quiet-hour violations, zero restart duplicates, no default raw audio/video persistence, and consent revocation within one cycle.
