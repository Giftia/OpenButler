'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {
  CAPABILITIES, CaptureProviderRegistry, CapturePipeline, canonicalSourceId,
  createPendingProvider, createNanoKvmGoPlusProvider, inspectMcpCaptureCapability, schemaDigest,
} = require('../src/capture-providers.cjs');

// All frames are short synthetic byte strings, not captured screenshots.
const policy = {redaction_policy_revision: 'rules-v1', excluded_apps: ['password-manager'], masks: []};
function fixture(options = {}) {
  let now = Date.parse('2026-10-02T00:00:00Z');
  let sequence = 0;
  const calls = [];
  const events = [];
  const buffers = [];
  const source = {source_id: 'os-native/monitor-1', local_id: 'monitor-1', generation: 'session-1',
    source_kind: 'raw-frame', display_id: 'monitor-1', window_id: null, ...options.source};
  const descriptor = {provider_id: 'os-native', label: 'Synthetic native adapter', kind: 'os-native',
    status: 'ready', acquisition_locality: 'local', source_kinds: ['raw-frame'],
    capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, 'supported'])), ...options.descriptor};
  const provider = {descriptor,
    listSources: async () => { calls.push('list'); return [source]; },
    inspectSource: async binding => {
      calls.push('inspect');
      return {...binding, observed_at_ms: now, locked: false,
        foreground_app: {id: 'editor.exe', authority: 'os'},
        visible_apps: [{id: 'editor.exe', authority: 'os'}], ...options.inspection?.()};
    },
    acquireFrame: async binding => {
      calls.push('acquire'); sequence++;
      const buffer = Buffer.from('SYNTHETIC RAW FRAME'); buffers.push(buffer);
      return {...binding, buffer, width: 20, height: 10, mime_type: 'image/png',
        frame_id: `frame-${sequence}`, captured_at_ms: now, sequence,
        timestamp_authority: 'host', clock_uncertainty_ms: 0, ...options.frame?.(sequence)};
    },
  };
  const registry = new CaptureProviderRegistry(); registry.register(provider);
  const privacyGate = options.privacyGate || (async request => {
    calls.push('authorize');
    return {...request.source, authorized: true, expires_at_ms: now + 60_000,
      redaction_policy_revision: request.redaction_policy_revision,
      policy_fingerprint: request.policy_fingerprint};
  });
  const redactor = {locality: 'local', redact: async request => {
    calls.push('redact');
    const buffer = Buffer.from('SYNTHETIC REDACTED FRAME'); buffers.push(buffer);
    const result = {buffer, detection_status: 'policy_applied', uncertainty: {review_required: false},
      redaction_policy_revision: request.policy.redaction_policy_revision,
      policy_fingerprint: request.policy_fingerprint, ...options.redact?.(request)};
    // Test overrides can replace the output. The fixture still owns its unused allocation.
    if (result.buffer !== buffer) buffer.fill(0);
    return result;
  }, ...options.redactor};
  const analyzer = {locality: 'local', analyze: async request => {
    calls.push('analyze');
    assert.equal(request.buffer.toString(), 'SYNTHETIC REDACTED FRAME');
    assert.ok(buffers[0].every(byte => byte === 0), 'raw must be wiped before analysis');
    return {text: 'Synthetic edited document', summary: 'Synthetic activity',
      ignored_path: '/private/synthetic', ignored_buffer: Buffer.from('DO NOT PERSIST')};
  }, ...options.analyzer};
  const publish = options.publish || (async event => {
    calls.push('publish'); events.push(event);
    assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)), 'wipe before local sink');
  });
  const pipeline = new CapturePipeline({registry, privacyGate, redactor, analyzer, publish,
    clock: () => now, intervalMs: 1000, ...options.pipeline});
  return {pipeline, provider, registry, source, calls, events, buffers,
    request: () => ({selection: {...source}, policy: {...policy}}),
    advance: amount => { now += amount; }, now: () => now};
}

test('canonical IDs cannot collide across provider/local delimiter boundaries', () => {
  assert.equal(canonicalSourceId('vendor.unit', 'input:1'), 'vendor.unit/input:1');
  assert.throws(() => canonicalSourceId('vendor/input', '1'), /invalid_source_identity/);
  assert.throws(() => canonicalSourceId('vendor', 'input/1'), /invalid_source_identity/);
});

test('NanoKVM Go+ is an inert pending adapter, not a connected device', async () => {
  const provider = createNanoKvmGoPlusProvider();
  assert.equal(provider.descriptor.status, 'pending');
  assert.equal(provider.descriptor.capabilities.raw_frames, 'pending');
  assert.equal(provider.descriptor.capabilities.app_identity, 'unsupported');
  assert.equal(provider.descriptor.capabilities.lock_state, 'unsupported');
  assert.deepEqual(provider.descriptor.source_kinds, ['raw-frame', 'device-ocr', 'device-memory']);
  assert.deepEqual(await provider.listSources(), []);
  await assert.rejects(provider.acquireFrame(), /provider_not_ready/);
  const registry = new CaptureProviderRegistry(); registry.register(provider);
  await assert.rejects(registry.resolve({source_id: 'sipeed.nanokvm-go-plus/input-1'}), /provider_not_ready/);
  assert.throws(() => { provider.descriptor.status = 'ready'; }, TypeError);
});

test('new vendors can declare pending providers without universal MCP assumptions', async () => {
  const provider = createPendingProvider({provider_id: 'example.capture-card', label: 'Future card',
    acquisition_locality: 'local', capabilities: {app_identity: 'unsupported'}});
  assert.deepEqual(await provider.listSources(), []);
  assert.equal(provider.descriptor.capabilities.raw_frames, 'pending');
});

test('registry rejects duplicate providers/sources and snapshots capability metadata', async () => {
  const f = fixture();
  assert.throws(() => f.registry.register(f.provider), /duplicate_provider/);
  f.provider.descriptor.status = 'pending';
  assert.equal(f.registry.descriptors()[0].status, 'ready');
  const registry = new CaptureProviderRegistry();
  registry.register({...f.provider, descriptor: {...f.provider.descriptor, status: 'ready'},
    listSources: async () => [f.source, f.source]});
  await assert.rejects(registry.resolve(f.source), /duplicate_source/);
});

test('pipeline emits source-bound derived evidence after local privacy, and no pixels or extra fields', async () => {
  const f = fixture(); const result = await f.pipeline.sample(f.request());
  assert.equal(result.recorded, true);
  assert.deepEqual(f.calls, ['list', 'authorize', 'inspect', 'authorize', 'acquire', 'inspect',
    'authorize', 'redact', 'authorize', 'analyze', 'authorize', 'publish']);
  assert.equal(result.event.evidence.source.source_id, f.source.source_id);
  assert.equal(result.event.evidence.source.display_id, 'monitor-1');
  assert.equal(result.event.evidence.source.window_id, null);
  assert.equal(result.event.evidence.freshness.age_ms, 0);
  assert.equal(result.event.evidence.privacy.raw_retained, false);
  assert.equal(result.event.evidence.privacy.uncertainty.all_pii_detection_guaranteed, false);
  assert.equal(result.event.evidence.sampling.continuous, false);
  assert.match(result.event.evidence.evidence_boundary, /not_complete_activity/);
  const serialized = JSON.stringify(result.event);
  for (const forbidden of ['ignored_path', 'ignored_buffer', 'SYNTHETIC RAW', 'SYNTHETIC REDACTED', 'DO NOT PERSIST']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  assert.ok(Object.isFrozen(result.event));
});

test('default privacy gate denies before acquisition', async () => {
  const f = fixture({pipeline: {privacyGate: undefined}});
  const result = await f.pipeline.sample(f.request());
  assert.equal(result.reason, 'privacy_gate_denied');
  assert.ok(!f.calls.includes('acquire'));
});

for (const field of ['source_id', 'generation', 'display_id', 'window_id', 'source_kind',
  'redaction_policy_revision', 'policy_fingerprint']) {
  test(`privacy grant is invalid when ${field} changes`, async () => {
    const f = fixture({privacyGate: async request => ({...request.source, authorized: true,
      expires_at_ms: Date.parse('2026-10-03T00:00:00Z'),
      redaction_policy_revision: request.redaction_policy_revision,
      policy_fingerprint: request.policy_fingerprint, [field]: 'wrong'})});
    assert.equal((await f.pipeline.sample(f.request())).reason, 'privacy_gate_denied');
    assert.ok(!f.calls.includes('acquire'));
  });
}

test('expired privacy grant is denied', async () => {
  const f = fixture({privacyGate: async request => ({...request.source, authorized: true,
    expires_at_ms: 0, redaction_policy_revision: request.redaction_policy_revision,
    policy_fingerprint: request.policy_fingerprint})});
  assert.equal((await f.pipeline.sample(f.request())).reason, 'privacy_gate_denied');
});

test('rule content changes invalidate an old grant even if the revision is accidentally reused', async () => {
  let oldDigest;
  const f = fixture({privacyGate: async request => {
    oldDigest ||= request.policy_fingerprint;
    return {...request.source, authorized: true, expires_at_ms: Date.parse('2026-10-03T00:00:00Z'),
      redaction_policy_revision: request.redaction_policy_revision, policy_fingerprint: oldDigest};
  }});
  assert.equal((await f.pipeline.sample(f.request())).recorded, true);
  f.advance(1000);
  const request = f.request(); request.policy.masks = [{x: 0, y: 0, width: 3, height: 3}];
  assert.equal((await f.pipeline.sample(request)).reason, 'privacy_gate_denied');
});

for (const selection of [{generation: 'stale-session'}, {display_id: 'monitor-2'}, {window_id: 'window-2'}]) {
  test(`selection scope mismatch never falls back: ${JSON.stringify(selection)}`, async () => {
    const f = fixture(); const request = f.request(); Object.assign(request.selection, selection);
    assert.equal((await f.pipeline.sample(request)).reason, 'source_binding_mismatch');
    assert.ok(!f.calls.includes('acquire'));
  });
}

test('a missing selected source never falls back to the first screen', async () => {
  const f = fixture(); const request = f.request(); request.selection.source_id = 'os-native/missing';
  assert.equal((await f.pipeline.sample(request)).reason, 'source_not_found');
  assert.ok(!f.calls.includes('acquire'));
});

for (const [name, inspection, reason] of [
  ['unknown foreground', {foreground_app: null}, 'application_excluded_or_unknown'],
  ['OCR-inferred identity', {foreground_app: {id: 'editor.exe', authority: 'ocr'}}, 'application_excluded_or_unknown'],
  ['missing visible apps', {visible_apps: null}, 'application_excluded_or_unknown'],
  ['empty visible apps', {visible_apps: []}, 'application_excluded_or_unknown'],
  ['excluded foreground', {foreground_app: {id: 'Password-Manager.exe', authority: 'os'}}, 'application_excluded_or_unknown'],
  ['excluded background', {visible_apps: [{id: 'password-manager.exe', authority: 'os'}]}, 'application_excluded_or_unknown'],
  ['locked screen', {locked: true}, 'locked_or_unknown'],
  ['unknown lock state', {locked: null}, 'locked_or_unknown'],
  ['stale inspection', {observed_at_ms: 0}, 'inspection_stale'],
  ['wrong display inspection', {display_id: 'monitor-2'}, 'source_binding_mismatch'],
]) {
  test(`${name} blocks acquisition rather than full-screen fallback`, async () => {
    const f = fixture({inspection: () => inspection});
    assert.equal((await f.pipeline.sample(f.request())).reason, reason);
    assert.ok(!f.calls.includes('acquire')); assert.ok(!f.calls.includes('analyze'));
  });
}

test('lock/exclusion transition after acquisition wipes raw and blocks redaction/analysis', async () => {
  let inspections = 0;
  const f = fixture({inspection: () => (++inspections === 2 ? {locked: true} : {})});
  assert.equal((await f.pipeline.sample(f.request())).reason, 'locked_or_unknown');
  assert.ok(f.calls.includes('acquire')); assert.ok(!f.calls.includes('redact'));
  assert.ok(f.buffers[0].every(byte => byte === 0));
});

test('hardware frames without OS safety metadata remain blocked', async () => {
  const f = fixture({descriptor: {kind: 'external-hardware',
    capabilities: {...Object.fromEntries(CAPABILITIES.map(key => [key, 'supported'])), app_identity: 'unsupported'}},
  pipeline: {strictMode: false}});
  assert.equal((await f.pipeline.sample(f.request())).reason, 'privacy_capability_unavailable');
  assert.ok(!f.calls.includes('acquire'));
});

test('strict mode blocks network acquisition; raw analysis remains local even outside strict mode', async () => {
  for (const options of [{descriptor: {acquisition_locality: 'network'}},
    {redactor: {locality: 'external'}}, {analyzer: {locality: 'external'}},
    {pipeline: {strictMode: false}, analyzer: {locality: 'external'}}]) {
    const f = fixture(options);
    assert.equal((await f.pipeline.sample(f.request())).reason,
      options.descriptor ? 'strict_mode_blocked' : 'local_processing_required');
    assert.ok(!f.calls.includes('acquire'));
  }
});

test('device OCR/memory are distinct kinds and cannot masquerade as raw-frame evidence', async () => {
  for (const kind of ['device-ocr', 'device-memory']) {
    const f = fixture({source: {source_kind: kind}, descriptor: {source_kinds: [kind]}});
    assert.equal((await f.pipeline.sample(f.request())).reason, 'source_kind_not_supported');
    assert.ok(!f.calls.includes('acquire'));
  }
});

for (const [name, override, reason] of [
  ['wrong source', {source_id: 'os-native/monitor-2'}, 'source_binding_mismatch'],
  ['wrong window', {window_id: 'window-2'}, 'source_binding_mismatch'],
  ['invalid dimensions', {width: 999_999_999}, 'frame_invalid'],
  ['missing timestamp', {captured_at_ms: undefined}, 'frame_stale'],
  ['old timestamp', {captured_at_ms: 0}, 'frame_stale'],
  ['future timestamp', {captured_at_ms: Date.parse('2026-10-03T00:00:00Z')}, 'frame_stale'],
  ['unverified device clock', {timestamp_authority: 'device'}, 'frame_clock_unknown'],
  ['uncertainty exceeds freshness budget', {clock_uncertainty_ms: 6000}, 'frame_stale'],
]) {
  test(`frame fails closed for ${name}`, async () => {
    const f = fixture({frame: () => override});
    assert.equal((await f.pipeline.sample(f.request())).reason, reason);
    assert.ok(f.buffers.every(buffer => buffer.every(byte => byte === 0)));
    assert.ok(!f.calls.includes('analyze'));
  });
}

test('uncertain detection and changed policy fail closed; no promise of perfect PII detection', async () => {
  for (const override of [{detection_status: 'review_required'}, {uncertainty: {review_required: true}},
    {redaction_policy_revision: 'rules-v2'}, {policy_fingerprint: 'changed'}]) {
    const f = fixture({redact: () => override});
    assert.equal((await f.pipeline.sample(f.request())).recorded, false);
    assert.ok(!f.calls.includes('analyze'));
  }
});

test('redactor must transfer a separate buffer, never raw or a shared view', async () => {
  for (const view of [buffer => buffer, buffer => buffer.subarray(1)]) {
    const f = fixture({redact: ({frame}) => ({buffer: view(frame.buffer)})});
    assert.equal((await f.pipeline.sample(f.request())).reason, 'redaction_unavailable');
    assert.ok(!f.calls.includes('analyze'));
  }
});

test('revoked consent after local redaction blocks analysis and wipes both buffers', async () => {
  let checks = 0;
  const f = fixture({privacyGate: async request => ({...request.source, authorized: ++checks < 4,
    expires_at_ms: Date.parse('2026-10-03T00:00:00Z'),
    redaction_policy_revision: request.redaction_policy_revision, policy_fingerprint: request.policy_fingerprint})});
  assert.equal((await f.pipeline.sample(f.request())).reason, 'privacy_gate_denied');
  assert.ok(f.calls.includes('redact')); assert.ok(!f.calls.includes('analyze'));
  assert.ok(f.buffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('revoked consent after analysis blocks observation delivery', async () => {
  let checks = 0;
  const f = fixture({privacyGate: async request => ({...request.source, authorized: ++checks < 5,
    expires_at_ms: Date.parse('2026-10-03T00:00:00Z'),
    redaction_policy_revision: request.redaction_policy_revision, policy_fingerprint: request.policy_fingerprint})});
  assert.equal((await f.pipeline.sample(f.request())).reason, 'privacy_gate_denied');
  assert.ok(f.calls.includes('analyze')); assert.equal(f.events[0].type, 'capture_gap');
});

test('samples that grow stale during processing are dropped', async () => {
  const f = fixture({analyzer: {analyze: async () => {
    f.advance(6000); return {text: 'Synthetic', summary: 'Synthetic'};
  }}});
  assert.equal((await f.pipeline.sample(f.request())).reason, 'frame_stale');
});

test('sample cadence, sequence gaps, paused intervals, and replay are explicit', async () => {
  const f = fixture({frame: sequence => ({sequence: sequence * 2})});
  assert.equal((await f.pipeline.sample(f.request())).recorded, true);
  assert.equal((await f.pipeline.sample(f.request())).reason, 'not_due');
  f.advance(4000);
  const next = await f.pipeline.sample(f.request());
  assert.equal(next.event.evidence.sampling.missed_intervals, 3);
  assert.equal(next.event.evidence.sampling.sequence_gap, 1);
  const replay = fixture({frame: () => ({sequence: 1, frame_id: 'same'})});
  await replay.pipeline.sample(replay.request()); replay.advance(1000);
  assert.equal((await replay.pipeline.sample(replay.request())).reason, 'frame_replayed');
});

test('gap events contain no failure payload and successful recovery carries preceding gap', async () => {
  let fail = true;
  const f = fixture({redactor: {redact: async request => {
    if (fail) { fail = false; throw new Error('PRIVATE URL AND RAW SECRET'); }
    return {buffer: Buffer.from('SYNTHETIC REDACTED FRAME'), detection_status: 'policy_applied',
      uncertainty: {review_required: false}, redaction_policy_revision: request.policy.redaction_policy_revision,
      policy_fingerprint: request.policy_fingerprint};
  }}});
  const gap = await f.pipeline.sample(f.request());
  assert.equal(gap.reason, 'provider_or_processing_failed');
  assert.ok(!JSON.stringify(gap).includes('PRIVATE'));
  f.advance(1000);
  const result = await f.pipeline.sample(f.request());
  assert.equal(result.event.evidence.sampling.preceding_gap, 'provider_or_processing_failed');
});

test('overlapping samples are rejected without another acquisition', async () => {
  let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({analyzer: {analyze: async () => {
    entered(); await held; return {text: 'Synthetic', summary: 'Synthetic'};
  }}});
  const first = f.pipeline.sample(f.request()); await ready;
  assert.equal((await f.pipeline.sample(f.request())).reason, 'sample_in_progress');
  release(); assert.equal((await first).recorded, true);
  assert.equal(f.calls.filter(call => call === 'acquire').length, 1);
});

test('local sink failure is not reported as a persisted observation, and no automatic retry occurs', async () => {
  let writes = 0;
  const f = fixture({publish: async () => { writes++; throw new Error('sink unavailable'); }});
  await assert.rejects(f.pipeline.sample(f.request()), /sink unavailable/);
  assert.equal(writes, 1);
  assert.ok(f.buffers.every(buffer => buffer.every(byte => byte === 0)));
  f.advance(1000);
  await assert.rejects(f.pipeline.sample(f.request()), /sink unavailable/);
  assert.equal(writes, 2, 'explicit caller retry can continue; busy flag must clear');
});

test('MCP negotiation requires exact reviewed tool + input/output schemas; it never enables transport', () => {
  const tool = {name: 'vendor_frame_read_v2', inputSchema: {type: 'object', properties: {}},
    outputSchema: {type: 'object', properties: {image: {type: 'string'}}}, annotations: {readOnlyHint: true}};
  const binding = {tool_name: tool.name, source_kind: 'raw-frame', read_only_reviewed: true,
    input_schema_sha256: schemaDigest(tool.inputSchema), output_schema_sha256: schemaDigest(tool.outputSchema)};
  const inspect = (tools, bind = binding) => inspectMcpCaptureCapability({advertisedTools: tools, binding: bind});
  assert.equal(inspect([tool]).compatible, true);
  assert.equal(inspect([tool]).operational, false);
  assert.equal(inspect([tool]).reason, 'transport_not_implemented');
  assert.equal(inspect([tool], {...binding, read_only_reviewed: false}).reason, 'reviewed_binding_required');
  assert.equal(inspect([{...tool, name: 'universal_screenshot'}]).reason, 'exact_tool_required');
  assert.equal(inspect([tool, tool]).reason, 'exact_tool_required');
  assert.equal(inspect([{...tool, outputSchema: {type: 'string'}}]).reason, 'schema_changed_or_unreviewed');
  assert.equal(inspect([{...tool, inputSchema: undefined}]).compatible, false);
  assert.equal(schemaDigest({a: 1, b: 2}), schemaDigest({b: 2, a: 1}));
});

test('malformed policy/selection fails before any adapter is called', async () => {
  const f = fixture(); const request = f.request(); request.policy.masks = [{x: -1, y: 0, width: 1, height: 1}];
  await assert.rejects(f.pipeline.sample(request), /invalid_privacy_policy/);
  assert.deepEqual(f.calls, []);
});
