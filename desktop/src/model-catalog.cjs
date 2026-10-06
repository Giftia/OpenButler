'use strict';
const {randomBytes} = require('node:crypto');
const {localEndpoint, installedIds} = require('./local-model-discovery.cjs');
const {createTransport} = require('./model-catalog-http.cjs');
const {hostInfo} = require('./model-host-info.cjs');
const manifest = require('./model-catalog.v1.json');
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const INSPECTION_TTL = 10 * 60 * 1000;
const STATES = ['starting', 'downloading', 'verifying', 'succeeded', 'failed', 'interrupted'];
const record = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (error_code, fields = {}) => ({ok: false, error_code, ...fields});
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : value;
const safeCode = value => /^catalog_[a-z_]{1,60}$/.test(value || '') ? value : 'catalog_unavailable';

function validateManifest(source) {
  if (!source || !/^[A-Za-z0-9.-]{1,60}$/.test(source.catalogVersion)
      || !Array.isArray(source.entries) || source.entries.length < 1 || source.entries.length > 8) throw new Error('catalog_invalid_manifest');
  const ids = new Set(), models = new Set();
  for (const entry of source.entries) {
    if (!/^[a-z0-9-]{1,80}$/.test(entry.id) || ids.has(entry.id) || models.has(entry.model)
        || entry.backend !== 'ollama' || !/^[a-z0-9-]+:[A-Za-z0-9._-]+$/.test(entry.model)
        || !DIGEST.test(entry.manifestDigest) || !Array.isArray(entry.roles) || !entry.roles.length
        || entry.roles.some(role => !['image', 'text'].includes(role)) || !Array.isArray(entry.assets)
        || entry.assets.length < 1 || entry.assets.length > 32
        || new Set(entry.assets.map(asset => asset.digest)).size !== entry.assets.length
        || entry.assets.some(asset => !DIGEST.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size < 1
          || !/^application\/vnd\.[a-z0-9.+-]+$/.test(asset.mediaType))
        || entry.assets.reduce((sum, asset) => sum + asset.size, 0) !== entry.downloadBytes
        || entry.downloadBytes > 32 * 1024 ** 3) throw new Error('catalog_invalid_manifest');
    ids.add(entry.id); models.add(entry.model);
  }
  return clone(source);
}

function catalogInventory(value, entries) {
  installedIds(value); // Also rejects unbounded/malformed IDs and conflicting aliases.
  const names = new Set();
  for (const item of value.models) {
    if (names.has(item.name)) throw new Error('catalog_invalid_response');
    names.add(item.name);
    if (!DIGEST.test(digest(item.digest))) throw new Error('catalog_invalid_response');
  }
  return entries.map(entry => {
    const item = value.models.find(item => item.name === entry.model);
    return {id: entry.id, installed: Boolean(item), digestMatches: item ? digest(item.digest) === entry.manifestDigest : false,
      imageMetadataVerified: false, fit: 'unknown'};
  });
}
function validCapabilities(show) {
  return show && typeof show === 'object' && !Array.isArray(show)
    && Array.isArray(show.capabilities) && show.capabilities.length <= 32
    && show.capabilities.every(value => typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value))
    && show.capabilities.includes('completion');
}

function createModelCatalog({transport = createTransport(), deviceInfo = hostInfo, source = manifest,
  now = Date.now, id = () => randomBytes(16).toString('hex'),
  readJournal = () => null, writeJournal = () => { throw new Error('journal_required'); }} = {}) {
  const catalog = validateManifest(source);
  let job = null, journalLoaded = false, journalBlocked = false, busy = false, lastInspect = -Infinity;
  let inspection = null, operation = null;
  const byId = value => catalog.entries.find(entry => entry.id === value);
  const snapshot = () => job ? clone(job) : null;
  const iso = () => new Date(now()).toISOString();
  function load() {
    if (journalLoaded) return;
    journalLoaded = true;
    try {
      const saved = readJournal();
      if (saved === null) return;
      const entry = byId(saved?.catalogId);
      if (!entry || !ID.test(saved.id) || !STATES.includes(saved.state)
          || !['active', 'terminal', 'unknown'].includes(saved.serverState)
          || saved.manifestDigest !== entry.manifestDigest || saved.model !== entry.model
          || !Number.isSafeInteger(saved.completedBytes) || saved.completedBytes < 0
          || saved.completedBytes > entry.downloadBytes || saved.totalBytes !== entry.downloadBytes
          || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error('journal_invalid');
      const endpoint = localEndpoint(saved.endpoint).endpoint;
      const terminal = saved.serverState === 'terminal' && ['succeeded', 'failed'].includes(saved.state);
      job = {id: saved.id, catalogId: entry.id, model: entry.model, manifestDigest: entry.manifestDigest,
        endpoint, state: terminal ? saved.state : 'interrupted', phase: terminal ? saved.state : 'connection_lost',
        completedBytes: saved.completedBytes, totalBytes: entry.downloadBytes,
        updatedAt: saved.updatedAt, serverState: terminal ? 'terminal' : 'unknown',
        canRetry: terminal && saved.state === 'failed' && saved.canRetry === true,
        ...(terminal && saved.error_code ? {error_code: safeCode(saved.error_code)} : {}),
        ...(!terminal ? {error_code: 'catalog_server_state_unknown'} : {})};
    } catch { journalBlocked = true; }
  }
  function persist() {
    try { writeJournal(snapshot()); return true; }
    catch { journalBlocked = true; if (job) job.canRetry = false; return false; }
  }
  function update(fields, save = false) {
    if (!job) return;
    Object.assign(job, fields, {updatedAt: iso()});
    if (save) persist();
  }
  async function inventory(selected, signal) {
    const rows = catalogInventory(await transport.json(selected, '/api/tags', undefined, {signal}), catalog.entries);
    for (const row of rows) {
      const entry = byId(row.id);
      if (row.digestMatches && entry.roles.includes('image')) {
        const show = await transport.json(selected, '/api/show', {model: entry.model, verbose: false}, {signal});
        row.imageMetadataVerified = Boolean(validCapabilities(show) && show.capabilities.includes('vision'));
      }
    }
    return rows;
  }
  async function inspect(input, {isCurrent = () => true} = {}) {
    load();
    if (!record(input, ['endpoint', 'protocol']) || input.protocol !== 'ollama_native') return failure('catalog_invalid_request', {endpoint: ''});
    let selected;
    try { selected = localEndpoint(input.endpoint); } catch { return failure('catalog_invalid_endpoint', {endpoint: ''}); }
    if (busy || now() - lastInspect < 1000) return failure('catalog_inspection_busy', {endpoint: selected.endpoint});
    busy = true; lastInspect = now(); inspection = null;
    let device;
    try { device = deviceInfo(); } catch { device = {platform: 'unknown', arch: 'unknown', scope: 'desktop_process',
      memoryBytes: null, availableMemoryBytes: null, memorySource: 'unknown', cpuCount: null, gpu: 'unknown'}; }
    const base = {endpoint: selected.endpoint, device, runtime: {available: false, version: null,
      hostRelation: 'unknown', hardwareVerified: false}, entries: []};
    try {
      const version = await transport.json(selected, '/api/version');
      if (!version || !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:[-+][A-Za-z0-9.-]{1,40})?$/.test(version.version))
        throw new Error('catalog_invalid_response');
      if (!isCurrent()) return failure('catalog_inspection_stale', {endpoint: selected.endpoint});
      const rows = await inventory(selected);
      if (!isCurrent()) return failure('catalog_inspection_stale', {endpoint: selected.endpoint});
      const inspectionId = id();
      inspection = {id: inspectionId, selected, created: now(), entries: rows};
      // Installed metadata is useful even after disconnect, but does not prove
      // that the remote pull has stopped. Never release the unknown-state lock
      // based on /tags or /show: neither is a pull-job status API.
      return {ok: true, ...base, inspectionId, runtime: {...base.runtime, available: true, version: version.version}, entries: rows};
    } catch (e) { return failure(safeCode(e.code || e.message), base); }
    finally { busy = false; }
  }
  function catalogLink(input) {
    if (!record(input, ['catalogId', 'kind']) || typeof input.catalogId !== 'string'
        || input.catalogId.length > 80 || !['source', 'license'].includes(input.kind)) return null;
    const entry = byId(input.catalogId);
    if (!entry) return null;
    const url = input.kind === 'source' ? entry.sourceUrl : entry.license?.url;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://ollama.com' || parsed.username || parsed.password || parsed.search || parsed.hash
          || !parsed.pathname.startsWith('/library/')) return null;
      return url;
    } catch { return null; }
  }
  function getCatalog() { return {ok: true, catalogVersion: catalog.catalogVersion, entries: clone(catalog.entries)}; }
  function status(input = {}) {
    load();
    if (!record(input, ['jobId']) || (input.jobId !== undefined && !ID.test(input.jobId))) return failure('catalog_invalid_job');
    if (input.jobId !== undefined && input.jobId !== job?.id) return failure('catalog_job_not_found');
    return {ok: !journalBlocked, job: snapshot(), ...(journalBlocked ? {error_code: 'catalog_journal_unavailable'} : {})};
  }
  async function run(selected, entry, controller, jobId) {
    let terminal = null;
    const completed = new Map();
    const current = () => job?.id === jobId && operation?.controller === controller && !controller.signal.aborted;
    try {
      const before = catalogInventory(await transport.json(selected, '/api/tags', undefined, {signal: controller.signal}), catalog.entries)
        .find(row => row.id === entry.id);
      if (!current()) return;
      if (before?.installed) {
        update({state: 'failed', phase: 'preflight_failed', serverState: 'terminal', canRetry: false,
          error_code: before.digestMatches ? 'catalog_already_installed' : 'catalog_existing_digest_mismatch'}, true);
        return;
      }
      operation.dispatched = true;
      await transport.pull(selected, entry.model, {signal: controller.signal, onRecord: value => {
        if (!current()) throw Object.assign(new Error(), {code: 'catalog_request_interrupted'});
        if (terminal || typeof value.status !== 'string' && typeof value.error !== 'string')
          throw Object.assign(new Error(), {code: 'catalog_invalid_response'});
        if (Object.hasOwn(value, 'error')) {
          if (typeof value.error !== 'string' || value.error.length > 4096) throw Object.assign(new Error(), {code: 'catalog_invalid_response'});
          terminal = 'error'; return; // Only clean stream end confirms server failure.
        }
        if (value.status.length > 200) throw Object.assign(new Error(), {code: 'catalog_invalid_response'});
        if (value.status === 'success') { terminal = 'success'; return; }
        if (Object.hasOwn(value, 'digest')) {
          const asset = entry.assets.find(asset => asset.digest === digest(value.digest));
          if (!asset || value.total !== asset.size || (value.completed !== undefined
            && (!Number.isSafeInteger(value.completed) || value.completed < 0 || value.completed > asset.size)))
            throw Object.assign(new Error(), {code: 'catalog_asset_mismatch'});
          const count = value.completed || 0;
          if (count < (completed.get(asset.digest) || 0)) throw Object.assign(new Error(), {code: 'catalog_invalid_response'});
          completed.set(asset.digest, count);
          update({state: 'downloading', phase: 'downloading', completedBytes: [...completed.values()].reduce((a, b) => a + b, 0)});
        } else {
          const phases = {'pulling manifest': 'pulling_manifest', 'verifying sha256 digest': 'checking_assets',
            'writing manifest': 'writing_manifest', 'removing any unused layers': 'finalizing'};
          if (!phases[value.status]) throw Object.assign(new Error(), {code: 'catalog_invalid_response'});
          update({state: 'downloading', phase: phases[value.status]});
        }
      }});
      if (!current()) return;
      if (terminal === 'error') {
        update({state: 'failed', phase: 'failed', serverState: 'terminal', canRetry: true,
          error_code: 'catalog_server_error'}, true); return;
      }
      if (terminal !== 'success') throw Object.assign(new Error(), {code: 'catalog_incomplete_stream'});
      update({state: 'verifying', phase: 'verifying_metadata', serverState: 'terminal'});
      try {
        const rows = await inventory(selected, controller.signal);
        if (!current()) return;
        const row = rows.find(row => row.id === entry.id);
        if (!row?.installed || !row.digestMatches) throw new Error('catalog_digest_mismatch');
        if (entry.roles.includes('image') && !row.imageMetadataVerified) throw new Error('catalog_vision_unverified');
        update({state: 'succeeded', phase: 'succeeded', completedBytes: entry.downloadBytes,
          serverState: 'terminal', canRetry: false}, true);
      } catch (e) {
        if (!current()) return;
        update({state: 'failed', phase: 'verification_failed', serverState: 'terminal', canRetry: false,
          error_code: safeCode(e.code || e.message)}, true);
      }
    } catch (e) {
      if (current()) {
        const dispatched = operation.dispatched;
        update({state: dispatched ? 'interrupted' : 'failed', phase: dispatched ? 'connection_lost' : 'preflight_failed',
          serverState: dispatched ? 'unknown' : 'terminal', canRetry: !dispatched,
          error_code: safeCode(e.code || e.message)}, true);
      }
    } finally {
      if (operation?.controller === controller) operation = null;
    }
  }
  function start(input, {isCurrent = () => true} = {}) {
    load();
    if (!record(input, ['inspectionId', 'catalogId', 'downloadConsent']) || input.downloadConsent !== true
        || !ID.test(input.inspectionId) || typeof input.catalogId !== 'string' || input.catalogId.length > 80)
      return failure('catalog_download_consent_required');
    if (journalBlocked) return failure('catalog_journal_unavailable');
    if (operation || (job && job.serverState !== 'terminal')) return failure('catalog_server_state_unknown', {job: snapshot()});
    if (!inspection || input.inspectionId !== inspection.id || now() - inspection.created > INSPECTION_TTL || !isCurrent())
      return failure('catalog_inspection_stale');
    const entry = byId(input.catalogId);
    if (!entry || entry.downloadSupported !== true) return failure('catalog_entry_unavailable');
    const row = inspection.entries.find(row => row.id === entry.id);
    if (row?.installed) return failure(row.digestMatches ? 'catalog_already_installed' : 'catalog_existing_digest_mismatch');
    if (job?.catalogId === entry.id && job.state === 'failed' && job.canRetry !== true
        && inspection.created <= Date.parse(job.updatedAt))
      return failure('catalog_reinspection_required');
    const selected = inspection.selected;
    const jobId = id();
    job = {id: jobId, catalogId: entry.id, model: entry.model, manifestDigest: entry.manifestDigest,
      endpoint: selected.endpoint, state: 'starting', phase: 'starting', completedBytes: 0, totalBytes: entry.downloadBytes,
      serverState: 'active', canRetry: false, updatedAt: iso()};
    // Durable write precedes the first byte sent. If the process crashes during
    // pull, next launch recovers an unknown-state lock instead of double-pulling.
    if (!persist()) return failure('catalog_journal_unavailable', {job: snapshot()});
    const controller = new AbortController();
    operation = {controller, jobId, dispatched: false};
    void run(selected, entry, controller, jobId);
    return {ok: true, job: snapshot()};
  }
  function cancel(input) {
    load();
    if (!record(input, ['jobId']) || !ID.test(input.jobId)) return failure('catalog_invalid_job');
    if (input.jobId !== job?.id) return failure('catalog_job_not_found');
    if (!operation) return {ok: true, job: snapshot()};
    const wasTerminal = job.serverState === 'terminal', dispatched = operation.dispatched;
    operation.controller.abort(); operation = null;
    update({state: wasTerminal || !dispatched ? 'failed' : 'interrupted', phase: 'connection_lost',
      serverState: wasTerminal || !dispatched ? 'terminal' : 'unknown', canRetry: !dispatched,
      error_code: !dispatched ? 'catalog_cancelled_before_download'
        : wasTerminal ? 'catalog_verification_interrupted' : 'catalog_server_state_unknown'}, true);
    return {ok: true, job: snapshot()};
  }
  function close() {
    inspection = null;
    if (operation && job) cancel({jobId: job.id});
  }
  return {getCatalog, catalogLink, inspect, start, status, cancel, close};
}
module.exports = {createModelCatalog, validateManifest, catalogInventory, INSPECTION_TTL};
