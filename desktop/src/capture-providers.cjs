'use strict';

// Contract-only, dependency-injected framework. Not imported by the desktop runtime.
// No OS capture, network transport, MCP invocation, storage, timer, or control tools.
const {createHash} = require('node:crypto');

const CAPABILITIES = Object.freeze(['raw_frames', 'app_identity', 'visible_apps',
  'window_capture', 'lock_state', 'device_ocr', 'device_memory']);
const SOURCE_KINDS = Object.freeze(['raw-frame', 'device-ocr', 'device-memory']);
const EVIDENCE_BOUNDARY = 'sampled_screen_not_complete_activity_or_verified_external_state';
const token = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value);
const check = (condition, code) => { if (!condition) throw new Error(code); };
const epoch = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const state = value => ['supported', 'pending', 'unsupported'].includes(value);
const freeze = value => {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function schemaDigest(schema) {
  check(schema && typeof schema === 'object' && !Array.isArray(schema), 'invalid_schema');
  return createHash('sha256').update(stableJson(schema)).digest('hex');
}
function canonicalSourceId(providerId, localId) {
  check(token(providerId) && token(localId), 'invalid_source_identity');
  // A delimiter disallowed in tokens prevents provider/local ID collisions.
  return `${providerId}/${localId}`;
}
function descriptorOf(input) {
  check(input && token(input.provider_id) && typeof input.label === 'string'
    && input.label.length > 0 && input.label.length <= 160, 'invalid_provider');
  check(['os-native', 'external-hardware'].includes(input.kind)
    && ['ready', 'pending', 'unsupported'].includes(input.status)
    && ['local', 'network'].includes(input.acquisition_locality), 'invalid_provider');
  check(Array.isArray(input.source_kinds) && input.source_kinds.length > 0
    && input.source_kinds.every(kind => SOURCE_KINDS.includes(kind)), 'invalid_provider');
  check(input.capabilities && CAPABILITIES.every(key => state(input.capabilities[key])),
    'invalid_provider_capabilities');
  return freeze({provider_id: input.provider_id, label: input.label, kind: input.kind,
    status: input.status, acquisition_locality: input.acquisition_locality,
    source_kinds: [...new Set(input.source_kinds)],
    capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, input.capabilities[key]]))});
}
function sourceOf(input, descriptor) {
  check(input && token(input.local_id) && token(input.generation)
    && token(input.display_id) && (input.window_id === null || token(input.window_id))
    && descriptor.source_kinds.includes(input.source_kind), 'invalid_source');
  check(input.source_id === canonicalSourceId(descriptor.provider_id, input.local_id),
    'source_binding_mismatch');
  return freeze({provider_id: descriptor.provider_id, source_id: input.source_id,
    local_id: input.local_id, generation: input.generation, source_kind: input.source_kind,
    display_id: input.display_id, window_id: input.window_id});
}
const bindingOf = source => ({source_id: source.source_id, generation: source.generation,
  display_id: source.display_id, window_id: source.window_id, source_kind: source.source_kind});
const matches = (value, source) => value && Object.entries(bindingOf(source))
  .every(([key, expected]) => value[key] === expected);

function policyOf(input) {
  check(input && token(input.redaction_policy_revision) && Array.isArray(input.excluded_apps)
    && input.excluded_apps.length > 0 && input.excluded_apps.length <= 100
    && input.excluded_apps.every(id => typeof id === 'string' && id.trim().length > 0
      && id.length <= 160) && Array.isArray(input.masks) && input.masks.length <= 100,
  'invalid_privacy_policy');
  const masks = input.masks.map(rect => {
    check(rect && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key]))
      && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0,
    'invalid_privacy_policy');
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  });
  return freeze({redaction_policy_revision: input.redaction_policy_revision,
    excluded_apps: input.excluded_apps.map(id => id.toLowerCase()), masks});
}

class CaptureProviderRegistry {
  #providers = new Map();

  register(provider) {
    const descriptor = descriptorOf(provider?.descriptor);
    check(!this.#providers.has(descriptor.provider_id), 'duplicate_provider');
    check(typeof provider.listSources === 'function', 'invalid_provider');
    if (descriptor.status === 'ready' && descriptor.source_kinds.includes('raw-frame')) {
      check(typeof provider.inspectSource === 'function' && typeof provider.acquireFrame === 'function',
        'invalid_provider');
    }
    // Snapshot the trusted callbacks and manifest, so mutation cannot upgrade capabilities.
    this.#providers.set(descriptor.provider_id, {descriptor,
      listSources: provider.listSources.bind(provider),
      inspectSource: provider.inspectSource?.bind(provider),
      acquireFrame: provider.acquireFrame?.bind(provider)});
    return descriptor;
  }

  descriptors() { return [...this.#providers.values()].map(provider => provider.descriptor); }

  async resolve(selection) {
    check(selection && typeof selection.source_id === 'string', 'invalid_selection');
    const providerId = selection.source_id.split('/')[0];
    const provider = this.#providers.get(providerId);
    check(provider, 'provider_not_found');
    check(provider.descriptor.status === 'ready', 'provider_not_ready');
    const inputs = await provider.listSources();
    check(Array.isArray(inputs) && inputs.length <= 100, 'invalid_sources');
    const sources = inputs.map(input => sourceOf(input, provider.descriptor));
    check(new Set(sources.map(source => source.source_id)).size === sources.length, 'duplicate_source');
    const source = sources.find(candidate => candidate.source_id === selection.source_id);
    check(source, 'source_not_found');
    check(matches(selection, source), 'source_binding_mismatch');
    return {provider, source};
  }
}

function createPendingProvider({provider_id, label, kind = 'external-hardware',
  source_kinds = ['raw-frame'], acquisition_locality = 'network', capabilities = {}}) {
  const descriptor = descriptorOf({provider_id, label, kind, source_kinds,
    acquisition_locality, status: 'pending', capabilities: Object.fromEntries(CAPABILITIES
      .map(key => [key, capabilities[key] || 'pending']))});
  return Object.freeze({descriptor, listSources: async () => [],
    inspectSource: async () => { throw new Error('provider_not_ready'); },
    acquireFrame: async () => { throw new Error('provider_not_ready'); }});
}

function createNanoKvmGoPlusProvider() {
  return createPendingProvider({provider_id: 'sipeed.nanokvm-go-plus', label: 'NanoKVM Go+',
    source_kinds: ['raw-frame', 'device-ocr', 'device-memory'], capabilities: {
      // Device support in documentation is not a verified OpenButler adapter.
      app_identity: 'unsupported', visible_apps: 'unsupported', window_capture: 'unsupported',
      lock_state: 'unsupported', raw_frames: 'pending', device_ocr: 'pending', device_memory: 'pending',
    }});
}

// Pure schema inspection, never MCP discovery or invocation. Tool names are vendor/version
// specific. A readOnlyHint alone is not authority; the binding needs independent review.
function inspectMcpCaptureCapability({advertisedTools, binding}) {
  const pending = reason => ({compatible: false, operational: false, reason});
  if (!Array.isArray(advertisedTools) || !binding || !token(binding.tool_name)
    || binding.read_only_reviewed !== true || !SOURCE_KINDS.includes(binding.source_kind)) {
    return pending('reviewed_binding_required');
  }
  const matches = advertisedTools.filter(tool => tool?.name === binding.tool_name);
  if (matches.length !== 1) return pending('exact_tool_required');
  const tool = matches[0];
  try {
    if (schemaDigest(tool.inputSchema) !== binding.input_schema_sha256
      || schemaDigest(tool.outputSchema) !== binding.output_schema_sha256) {
      return pending('schema_changed_or_unreviewed');
    }
  } catch { return pending('schema_changed_or_unreviewed'); }
  return freeze({compatible: true, operational: false, reason: 'transport_not_implemented',
    tool_name: binding.tool_name, source_kind: binding.source_kind,
    input_schema_sha256: binding.input_schema_sha256,
    output_schema_sha256: binding.output_schema_sha256});
}

const REASONS = new Set(['provider_not_found', 'provider_not_ready', 'invalid_sources',
  'duplicate_source', 'invalid_source', 'source_not_found', 'source_binding_mismatch',
  'source_kind_not_supported', 'privacy_gate_denied', 'privacy_capability_unavailable',
  'strict_mode_blocked', 'local_processing_required', 'inspection_stale', 'inspection_invalid', 'locked_or_unknown',
  'application_excluded_or_unknown', 'frame_invalid', 'frame_stale', 'frame_clock_unknown',
  'frame_replayed', 'redaction_unavailable', 'redaction_review_required', 'analysis_invalid']);
const safeReason = error => REASONS.has(error?.message) ? error.message : 'provider_or_processing_failed';

/**
 * Non-integrated test seam. All dependencies must be trusted, reviewed local code.
 * privacyGate is the existing source-bound consent/preview authority, NOT a new grant UI.
 * It must revalidate current consent on every call; default is deny. publish is a LOCAL
 * context/timeline sink. Only derived, allowlisted observations/gaps reach it.
 */
class CapturePipeline {
  #registry; #privacyGate; #redactor; #analyzer; #publish; #clock; #strict;
  #intervalMs; #maxAgeMs; #inspectionAgeMs; #history = new Map(); #busy = new Set();

  constructor({registry, privacyGate = async () => null, redactor, analyzer, publish,
    clock = () => Date.now(), strictMode = true, intervalMs = 60_000,
    maxFrameAgeMs = 5_000, maxInspectionAgeMs = 1_000}) {
    check(registry instanceof CaptureProviderRegistry && typeof privacyGate === 'function'
      && typeof redactor?.redact === 'function' && typeof analyzer?.analyze === 'function'
      && typeof publish === 'function' && typeof clock === 'function', 'invalid_pipeline');
    check([intervalMs, maxFrameAgeMs, maxInspectionAgeMs].every(value =>
      Number.isSafeInteger(value) && value > 0) && typeof strictMode === 'boolean', 'invalid_pipeline');
    this.#registry = registry; this.#privacyGate = privacyGate;
    this.#redactor = {locality: redactor.locality, redact: redactor.redact.bind(redactor)};
    this.#analyzer = {locality: analyzer.locality, analyze: analyzer.analyze.bind(analyzer)};
    this.#publish = publish; this.#clock = clock; this.#strict = strictMode;
    this.#intervalMs = intervalMs; this.#maxAgeMs = maxFrameAgeMs;
    this.#inspectionAgeMs = maxInspectionAgeMs;
  }

  #now() { const now = this.#clock(); check(epoch(now), 'invalid_clock'); return now; }

  async #authorized(source, policy, digest) {
    const grant = await this.#privacyGate(freeze({source, policy,
      policy_fingerprint: digest, redaction_policy_revision: policy.redaction_policy_revision}));
    check(grant?.authorized === true && matches(grant, source)
      && grant.redaction_policy_revision === policy.redaction_policy_revision
      && grant.policy_fingerprint === digest && epoch(grant.expires_at_ms)
      && grant.expires_at_ms > this.#now(), 'privacy_gate_denied');
  }

  async #eligible(provider, source, policy) {
    const capabilities = provider.descriptor.capabilities;
    check(['raw_frames', 'app_identity', 'visible_apps', 'lock_state']
      .every(key => capabilities[key] === 'supported')
      && (source.window_id === null || capabilities.window_capture === 'supported'),
    'privacy_capability_unavailable');
    const inspection = await provider.inspectSource(source);
    check(matches(inspection, source), 'source_binding_mismatch');
    const age = this.#now() - inspection.observed_at_ms;
    check(epoch(inspection.observed_at_ms) && age >= 0 && age <= this.#inspectionAgeMs,
      'inspection_stale');
    check(inspection.locked === false, 'locked_or_unknown');
    const apps = [inspection.foreground_app, ...(Array.isArray(inspection.visible_apps)
      ? inspection.visible_apps : [null])];
    check(apps.every(app => token(app?.id) && app.authority === 'os')
      && inspection.visible_apps?.length > 0, 'application_excluded_or_unknown');
    check(!apps.some(app => policy.excluded_apps.some(excluded =>
      app.id.toLowerCase().includes(excluded))), 'application_excluded_or_unknown');
    return inspection;
  }

  async sample({selection: inputSelection, policy: inputPolicy}) {
    // Reject malformed requests before any provider/publish callback. Copy only known fields.
    const policy = policyOf(inputPolicy);
    check(inputSelection && typeof inputSelection.source_id === 'string'
      && inputSelection.source_id.length <= 321 && token(inputSelection.generation)
      && token(inputSelection.display_id)
      && (inputSelection.window_id === null || token(inputSelection.window_id))
      && SOURCE_KINDS.includes(inputSelection.source_kind), 'invalid_selection');
    const selection = freeze(bindingOf(inputSelection));
    const key = selection.source_id;
    if (this.#busy.has(key)) return {recorded: false, reason: 'sample_in_progress'};
    const now = this.#now();
    const history = this.#history.get(key);
    if (history && now >= history.attempt_at_ms && now - history.attempt_at_ms < this.#intervalMs) {
      return {recorded: false, reason: 'not_due'};
    }
    this.#busy.add(key);
    let raw; let redacted; let event;
    try {
      const {provider, source} = await this.#registry.resolve(selection);
      check(source.source_kind === 'raw-frame', 'source_kind_not_supported');
      // Redaction and the current raw-frame analysis seam stay local even outside strict mode.
      // An approved summary-only external model seam would need its own reviewed contract.
      check(this.#redactor.locality === 'local' && this.#analyzer.locality === 'local', 'local_processing_required');
      check(!this.#strict || provider.descriptor.acquisition_locality === 'local', 'strict_mode_blocked');
      const digest = schemaDigest(policy);
      await this.#authorized(source, policy, digest);
      await this.#eligible(provider, source, policy);
      await this.#authorized(source, policy, digest);
      raw = await provider.acquireFrame(source);
      check(matches(raw, source), 'source_binding_mismatch');
      check(Buffer.isBuffer(raw.buffer) && raw.buffer.length > 0 && raw.buffer.length <= 8 * 1024 * 1024
        && token(raw.frame_id) && ['image/png', 'image/jpeg'].includes(raw.mime_type)
        && Number.isSafeInteger(raw.width) && raw.width > 0
        && Number.isSafeInteger(raw.height) && raw.height > 0 && raw.width * raw.height <= 16_000_000
        && Number.isSafeInteger(raw.sequence) && raw.sequence >= 0, 'frame_invalid');
      check(['host', 'device-verified'].includes(raw.timestamp_authority)
        && Number.isSafeInteger(raw.clock_uncertainty_ms) && raw.clock_uncertainty_ms >= 0,
      'frame_clock_unknown');
      const receivedAt = this.#now();
      const age = receivedAt - raw.captured_at_ms;
      check(epoch(raw.captured_at_ms) && age >= 0
        && age + raw.clock_uncertainty_ms <= this.#maxAgeMs, 'frame_stale');
      const previous = history?.accepted;
      if (previous && previous.generation === source.generation) {
        check(raw.sequence > previous.sequence && raw.captured_at_ms > previous.captured_at_ms
          && raw.frame_id !== previous.frame_id, 'frame_replayed');
      }
      // Recheck after acquisition; no OCR/AI when a lock/exclusion/scope changed mid-flight.
      await this.#eligible(provider, source, policy);
      await this.#authorized(source, policy, digest);
      redacted = await this.#redactor.redact({frame: raw, source, policy, policy_fingerprint: digest});
      check(redacted?.detection_status === 'policy_applied'
        && redacted.uncertainty?.review_required === false, 'redaction_review_required');
      check(Buffer.isBuffer(redacted.buffer) && redacted.buffer.length > 0
        && redacted.buffer.length <= 8 * 1024 * 1024
        && redacted.redaction_policy_revision === policy.redaction_policy_revision
        && redacted.policy_fingerprint === digest
        && !(raw.buffer.buffer === redacted.buffer.buffer
          && raw.buffer.byteOffset < redacted.buffer.byteOffset + redacted.buffer.length
          && redacted.buffer.byteOffset < raw.buffer.byteOffset + raw.buffer.length), 'redaction_unavailable');
      raw.buffer.fill(0);
      await this.#authorized(source, policy, digest);
      const analyzed = await this.#analyzer.analyze({buffer: redacted.buffer,
        mime_type: raw.mime_type, source, redaction_policy_revision: policy.redaction_policy_revision});
      check(analyzed && typeof analyzed.text === 'string' && analyzed.text.length <= 100_000
        && typeof analyzed.summary === 'string' && analyzed.summary.length <= 10_000,
      'analysis_invalid');
      await this.#authorized(source, policy, digest);
      const emittedAt = this.#now();
      check(emittedAt - raw.captured_at_ms + raw.clock_uncertainty_ms <= this.#maxAgeMs
        && emittedAt >= receivedAt, 'frame_stale');
      const missedIntervals = history ? Math.max(0, Math.floor((now - history.attempt_at_ms)
        / this.#intervalMs) - 1) : 0;
      event = freeze({type: 'capture_observation', text: analyzed.text, summary: analyzed.summary,
        evidence: {id: `${source.source_id}/${source.generation}/${raw.frame_id}`,
          kind: 'redacted-frame-observation', source, captured_at_ms: raw.captured_at_ms,
          received_at_ms: receivedAt, emitted_at_ms: emittedAt,
          provenance: {provider_id: source.provider_id, frame_id: raw.frame_id,
            timestamp_authority: raw.timestamp_authority},
          freshness: {age_ms: emittedAt - raw.captured_at_ms, max_age_ms: this.#maxAgeMs,
            clock_uncertainty_ms: raw.clock_uncertainty_ms},
          sampling: {continuous: false, interval_ms: this.#intervalMs, sequence: raw.sequence,
            missed_intervals: missedIntervals, preceding_gap: history?.gap_reason || null,
            sequence_gap: previous && previous.generation === source.generation
              ? raw.sequence - previous.sequence - 1 : 0},
          privacy: {redaction_policy_revision: policy.redaction_policy_revision,
            policy_fingerprint: digest, detection_status: 'policy_applied',
            uncertainty: {review_required: false, all_pii_detection_guaranteed: false},
            raw_retained: false, frame_replay_available: false}, evidence_boundary: EVIDENCE_BOUNDARY}});
    } catch (error) {
      event = freeze({type: 'capture_gap', source: selection, at_ms: now,
        reason: safeReason(error), evidence_boundary: EVIDENCE_BOUNDARY});
    } finally {
      if (Buffer.isBuffer(raw?.buffer)) raw.buffer.fill(0);
      if (Buffer.isBuffer(redacted?.buffer)) redacted.buffer.fill(0);
    }
    try {
      // Raw and masked buffers are disposed before this local sink is called.
      // Sink errors propagate; never claim persistence and never retry the sink implicitly.
      await this.#publish(event);
      this.#history.set(key, {attempt_at_ms: now,
        gap_reason: event.type === 'capture_gap' ? event.reason : null,
        accepted: event.type === 'capture_observation' ? {
          generation: selection.generation, sequence: event.evidence.sampling.sequence,
          frame_id: event.evidence.provenance.frame_id, captured_at_ms: event.evidence.captured_at_ms,
        } : history?.accepted});
      return {recorded: event.type === 'capture_observation',
        reason: event.type === 'capture_observation' ? 'recorded' : event.reason, event};
    } finally { this.#busy.delete(key); }
  }
}

module.exports = {CAPABILITIES, SOURCE_KINDS, EVIDENCE_BOUNDARY, canonicalSourceId, schemaDigest,
  CaptureProviderRegistry, CapturePipeline, createPendingProvider, createNanoKvmGoPlusProvider,
  inspectMcpCaptureCapability};
