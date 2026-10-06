'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const {createModelCatalog, validateManifest} = require('../src/model-catalog.cjs');
const {createTransport, LIMITS} = require('../src/model-catalog-http.cjs');
const {hostInfo} = require('../src/model-host-info.cjs');
const {localEndpoint} = require('../src/local-model-discovery.cjs');
const manifest = require('../src/model-catalog.v1.json');
const entry = manifest.entries[0];
const endpoint = 'http://localhost:11435';
const inspectInput = {endpoint, protocol: 'ollama_native'};
const next = () => new Promise(resolve => setImmediate(resolve));
const fakeDevice = {platform: 'test', arch: 'x64', memoryBytes: 1024, memorySource: 'cgroup_v2',
  availableMemoryBytes: 512, cpuCount: 2, gpu: 'unknown', scope: 'desktop_process'};
function harness({stream = [], pullFailure, inventory = [], show = {capabilities: ['completion', 'vision']}, journal = null,
  writeFailure = false, hold = false, version = '0.13.1', ...options} = {}) {
  const calls = [], writes = []; let currentInventory = inventory, onRecord, pending, clock = 0, n = 0;
  const transport = {
    async json(selected, path, body) {
      calls.push({selected, path, body});
      if (path === '/api/version') return {version};
      if (path === '/api/tags') return {models: currentInventory};
      if (path === '/api/show') return show;
      throw new Error('unexpected endpoint');
    },
    async pull(selected, model, args) {
      calls.push({selected, path: '/api/pull', body: {model, stream: true}}); onRecord = args.onRecord;
      args.signal.addEventListener('abort', () => pending?.reject(Object.assign(new Error(), {code: 'catalog_request_interrupted'})));
      if (hold) await new Promise((resolve, reject) => {pending = {resolve, reject};});
      for (const item of stream) args.onRecord(item);
      if (pullFailure) throw Object.assign(new Error('secret'), {code: pullFailure});
    },
  };
  const service = createModelCatalog({transport, deviceInfo: () => fakeDevice, now: () => clock,
    id: () => (++n).toString(16).padStart(32, '0'), readJournal: () => journal,
    writeJournal: value => { if (writeFailure) throw new Error('private path'); writes.push(value); }, ...options});
  return {service, calls, writes, setInventory(value) {currentInventory = value;}, tick(ms = 1001) {clock += ms;},
    emit(value) {onRecord(value);}, finish() {pending?.resolve();},
    async prepare() { const result = await service.inspect(inspectInput); assert.equal(result.ok, true); return result; },
    async start() {const result = await this.prepare(); return service.start({inspectionId: result.inspectionId,
      catalogId: entry.id, downloadConsent: true});}};
}
const installed = (model = entry, extra = {}) => ({name: model.model, model: model.model,
  digest: model.manifestDigest.slice(7), ...extra});

test('catalog pins reproduce raw official manifest SHA256 and all assets, without network', () => {
  assert.equal(validateManifest(manifest).entries.length, 3);
  for (const item of manifest.entries) {
    const raw = fs.readFileSync(path.join(__dirname, '../../docs/architecture/model-catalog-manifests', item.id + '.json'));
    assert.equal('sha256:' + createHash('sha256').update(raw).digest('hex'), item.manifestDigest);
    const source = JSON.parse(raw);
    assert.deepEqual(item.assets, [source.config, ...source.layers].map(({digest, size, mediaType}) => ({digest, size, mediaType})));
    assert.equal(item.downloadBytes, item.assets.reduce((sum, asset) => sum + asset.size, 0));
    assert.equal(item.memoryEvidence, 'unknown'); assert.equal(item.speedEvidence, 'unknown');
  }
  assert.deepEqual(manifest.entries[2].roles, ['text']);
});

test('catalog and status reads do not probe host or any model endpoint', () => {
  const h = harness({deviceInfo: () => {throw new Error('unexpected probe');}});
  assert.equal(h.service.getCatalog().ok, true); assert.deepEqual(h.service.status(), {ok: true, job: null});
  assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
  const output = h.service.getCatalog(); output.entries[0].model = 'evil';
  assert.equal(h.service.getCatalog().entries[0].model, entry.model);
});

test('explicit inspection pins localhost and never equates process hardware with model host', async () => {
  const h = harness(); const result = await h.prepare();
  assert.deepEqual(h.calls.map(call => call.path), ['/api/version', '/api/tags']);
  assert.equal(h.calls[0].selected.address, '127.0.0.1');
  assert.equal(result.runtime.hostRelation, 'unknown'); assert.equal(result.runtime.hardwareVerified, false);
  assert.deepEqual(result.device, fakeDevice); assert.ok(result.entries.every(row => row.fit === 'unknown'));
  assert.equal(h.writes.length, 0);
});

test('invalid endpoint, protocol, extra inputs, expired inspection and consent cannot dispatch pull', async () => {
  for (const bad of ['https://localhost:11435', 'http://evil.invalid', 'http://localhost:1/api', 'http://127.1', 'http://localhost:1?secret']) {
    const h = harness(); assert.equal((await h.service.inspect({...inspectInput, endpoint: bad})).ok, false); assert.equal(h.calls.length, 0);
  }
  const h = harness();
  assert.equal((await h.service.inspect({...inspectInput, api_key: 'secret'})).ok, false);
  assert.equal((await h.service.inspect({...inspectInput, protocol: 'openai'})).ok, false);
  const inspection = await h.prepare();
  for (const input of [{}, {inspectionId: inspection.inspectionId, catalogId: entry.id, downloadConsent: false},
    {inspectionId: inspection.inspectionId, catalogId: 'custom/model', downloadConsent: true},
    {inspectionId: inspection.inspectionId, catalogId: entry.id, downloadConsent: true, url: 'http://evil'}])
    assert.equal(h.service.start(input).ok, false);
  h.tick(600001);
  assert.equal(h.service.start({inspectionId: inspection.inspectionId, catalogId: entry.id, downloadConsent: true}).error_code, 'catalog_inspection_stale');
  assert.equal(h.calls.some(call => call.path === '/api/pull'), false);
});

test('stale main-frame inspection never issues a download token; repeated probes are bounded', async () => {
  const h = harness();
  assert.equal((await h.service.inspect(inspectInput, {isCurrent: () => false})).error_code, 'catalog_inspection_stale');
  assert.equal(h.calls.length, 1);
  assert.equal((await h.service.inspect(inspectInput)).error_code, 'catalog_inspection_busy');
  h.tick(); assert.equal((await h.service.inspect(inspectInput)).ok, true);
});

test('download is an exact catalog model and completes only after installed digest and image metadata', async () => {
  const h = harness({hold: true, stream: [{status: 'success'}]});
  const started = await h.start(); assert.equal(started.ok, true);
  assert.equal(h.writes[0].state, 'starting'); assert.equal(h.writes[0].serverState, 'active');
  assert.deepEqual(h.calls.at(-1).body, {model: entry.model, stream: true});
  h.emit({status: 'pulling manifest'});
  const asset = entry.assets[1]; h.emit({status: 'pulling layer', digest: asset.digest, total: asset.size, completed: 200});
  assert.equal(h.service.status().job.completedBytes, 200);
  h.setInventory([installed()]); h.finish(); await next();
  const job = h.service.status().job;
  assert.equal(job.state, 'succeeded'); assert.equal(job.serverState, 'terminal'); assert.equal(job.canRetry, false);
  assert.equal(job.completedBytes, entry.downloadBytes); assert.ok(h.calls.some(call => call.path === '/api/show'));
  assert.ok(h.calls.every(call => ['/api/version', '/api/tags', '/api/show', '/api/pull'].includes(call.path)));
});

test('false success, digest mismatch and absent vision metadata never pass validation', async () => {
  for (const [inventory, show, expected] of [[[], {}, 'catalog_digest_mismatch'],
    [[installed(entry, {digest: 'a'.repeat(64)})], {}, 'catalog_digest_mismatch'],
    [[installed()], {capabilities: ['completion']}, 'catalog_vision_unverified']]) {
    const h = harness({hold: true, stream: [{status: 'success'}], show}); await h.start();
    h.setInventory(inventory); h.finish(); await next();
    const job = h.service.status().job; assert.equal(job.state, 'failed'); assert.equal(job.error_code, expected);
    assert.equal(job.serverState, 'terminal'); assert.equal(job.canRetry, false);
  }
});

test('installed matching or drifted entry is never silently overwritten by download', async () => {
  for (const item of [installed(), installed(entry, {digest: 'f'.repeat(64)})]) {
    const h = harness({inventory: [item]}); const result = await h.start();
    assert.equal(result.ok, false); assert.equal(h.calls.some(call => call.path === '/api/pull'), false);
  }
});

test('disconnect truthfully retains unknown-server lock, including after restart and reinspection', async () => {
  const h = harness({hold: true}); const started = await h.start();
  assert.equal(h.service.start({inspectionId: '1'.padStart(32, '0'), catalogId: entry.id, downloadConsent: true}).ok, false);
  const stopped = h.service.cancel({jobId: started.job.id});
  assert.equal(stopped.job.state, 'interrupted'); assert.equal(stopped.job.serverState, 'unknown'); assert.equal(stopped.job.canRetry, false);
  h.setInventory([installed()]); h.tick(); await h.prepare();
  assert.equal(h.service.status().job.serverState, 'unknown');
  const restarted = harness({journal: h.writes.at(-1)}); const nextInspection = await restarted.prepare();
  assert.equal(restarted.service.start({inspectionId: nextInspection.inspectionId, catalogId: manifest.entries[2].id, downloadConsent: true}).error_code, 'catalog_server_state_unknown');
  assert.equal(restarted.calls.some(call => call.path === '/api/pull'), false);
});

test('crash journal is restored as interrupted and lifecycle close does not claim remote cancellation', async () => {
  const h = harness({hold: true}); await h.start();
  const recovered = harness({journal: h.writes[0]});
  assert.equal(recovered.service.status().job.state, 'interrupted'); assert.equal(recovered.calls.length, 0);
  h.service.close(); assert.equal(h.service.status().job.serverState, 'unknown'); await next();
});

test('bounded terminal server error permits explicit retry with same tag and runtime-managed cached layers', async () => {
  const h = harness({stream: [{error: 'private path or auth details'}]}); await h.start(); await next();
  const old = h.service.status().job;
  assert.equal(old.state, 'failed'); assert.equal(old.canRetry, true);
  assert.equal(JSON.stringify(old).includes('private'), false);
  h.tick(); const result = await h.start(); assert.equal(result.ok, true); assert.notEqual(result.job.id, old.id); await next();
  assert.equal(h.calls.filter(call => call.path === '/api/pull').length, 2);
});

test('transport failures, malformed progress and incomplete stream never permit overlapping retry', async () => {
  const cases = [{pullFailure: 'catalog_request_timeout'}, {stream: []},
    {stream: [{status: 'pulling', digest: 'sha256:' + 'f'.repeat(64), total: 10}]},
    {stream: [{status: 'pulling', digest: entry.assets[0].digest, total: entry.assets[0].size, completed: -1}]},
    {stream: [{status: 'success'}, {status: 'success'}]}, {stream: [{status: 'private path'}]}];
  for (const options of cases) {
    const h = harness(options); await h.start(); await next();
    const job = h.service.status().job; assert.equal(job.state, 'interrupted'); assert.equal(job.serverState, 'unknown'); assert.equal(job.canRetry, false);
  }
});

test('missing/corrupt/unwritable journal fails closed before network mutation', async () => {
  for (const options of [{journal: {}}, {writeFailure: true}]) {
    const h = harness(options); const result = await h.start(); assert.equal(result.error_code, 'catalog_journal_unavailable');
    assert.equal(h.calls.some(call => call.path === '/api/pull'), false);
  }
});

test('provider version/model IDs are bounded, conflicting duplicate metadata rejected', async () => {
  for (const options of [{version: 'private path or injected text'}, {inventory: [installed(), installed()]},
    {inventory: [installed(entry, {name: '../private'})]}, {inventory: [installed(entry, {digest: 'bad'})]}]) {
    const h = harness(options); const result = await h.service.inspect(inspectInput);
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('private path'), false);
  }
});

function transportFixture({status = 200, headers = {}, chunks, stall = false} = {}) {
  const calls = [], requests = [], responses = [];
  const request = (options, callback) => {
    calls.push(options);
    const req = new EventEmitter(); requests.push(req); req.destroy = () => {req.destroyed = true;};
    req.end = body => {
      req.body = body;
      if (stall) return;
      queueMicrotask(() => {
        const res = new EventEmitter(); responses.push(res); res.statusCode = status;
        res.headers = {'content-type': 'application/json', ...headers}; res.destroy = () => {res.destroyed = true;}; callback(res);
        for (const chunk of chunks || [Buffer.from('{"version":"0.13.1"}')]) if (!res.destroyed) res.emit('data', chunk);
        if (!res.destroyed) res.emit('end');
      });
    };
    return req;
  };
  return {request, calls, requests, responses};
}

test('transport uses literal loopback fixed paths, no redirect, credentials, proxy or raw provider errors', async () => {
  const f = transportFixture(), t = createTransport(f);
  assert.deepEqual(await t.json(localEndpoint(endpoint), '/api/version'), {version: '0.13.1'});
  assert.equal(f.calls[0].hostname, '127.0.0.1'); assert.equal(f.calls[0].agent, false);
  assert.equal(f.calls[0].headers.Authorization, undefined);
  for (const status of [301, 302, 307, 308, 401, 500]) {
    const f = transportFixture({status, headers: {location: 'http://private.invalid'}});
    await assert.rejects(createTransport(f).json(localEndpoint(endpoint), '/api/tags'), /catalog_http_error/);
    assert.equal(f.calls.length, 1);
  }
});

test('transport bounds JSON UTF8, content type, content encoding and total body size', async () => {
  const cases = [{headers: {'content-type': 'text/html'}}, {headers: {'content-encoding': 'gzip'}},
    {headers: {'content-length': String(LIMITS.jsonBytes + 1)}}, {chunks: [Buffer.alloc(LIMITS.jsonBytes + 1)]},
    {chunks: [Buffer.from([0xc3, 0x28])]}, {chunks: [Buffer.from('not json')]}];
  for (const options of cases) {
    const f = transportFixture(options); await assert.rejects(createTransport(f).json(localEndpoint(endpoint), '/api/tags'), /catalog_(invalid_response|response_too_large)/);
    assert.equal(f.requests[0].destroyed, true);
  }
});

test('NDJSON arbitrary chunk boundaries, final line, record/line/stream caps, timeout and abort', async () => {
  const records = [];
  await createTransport(transportFixture({headers: {'content-type': 'application/x-ndjson'},
    chunks: [Buffer.from('{"status":"pull'), Buffer.from('ing manifest"}\n{"status":"success"}')]}))
    .pull(localEndpoint(endpoint), entry.model, {onRecord: value => records.push(value)});
  assert.deepEqual(records, [{status: 'pulling manifest'}, {status: 'success'}]);
  for (const [limits, chunks] of [[{lineBytes: 4}, [Buffer.from('{"abcdef":1}\n')]],
    [{streamBytes: 4}, [Buffer.from('{"a":1}\n')]], [{streamRecords: 1}, [Buffer.from('{}\n{}\n')]]]) {
    const f = transportFixture({chunks}); await assert.rejects(createTransport({...f, limits: {...LIMITS, ...limits}})
      .pull(localEndpoint(endpoint), entry.model, {onRecord() {}}), /catalog_response_too_large/);
  }
  const f = transportFixture({stall: true});
  await assert.rejects(createTransport({...f, limits: {...LIMITS, idleTimeoutMs: 5}})
    .pull(localEndpoint(endpoint), entry.model, {onRecord() {}}), /catalog_request_timeout/);
  const controller = new AbortController(); const other = transportFixture({stall: true});
  const pending = createTransport(other).pull(localEndpoint(endpoint), entry.model, {onRecord() {}, signal: controller.signal});
  controller.abort(); await assert.rejects(pending, /catalog_request_interrupted/); assert.equal(other.requests[0].destroyed, true);
});

test('resource probe uses restrictive inherited cgroup limit and remaining allowance rather than 256GB host RAM', () => {
  const GiB = 1024 ** 3;
  const files = {'/proc/self/cgroup': '0::/parent/child',
    '/proc/self/mountinfo': '36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
    '/sys/fs/cgroup/parent/child/memory.max': String(16 * GiB), '/sys/fs/cgroup/parent/child/memory.current': String(GiB),
    '/sys/fs/cgroup/parent/memory.max': String(8 * GiB), '/sys/fs/cgroup/parent/memory.current': String(3 * GiB),
    '/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/parent/cpu.max': '200000 100000'};
  const result = hostInfo({platform: 'linux', arch: 'x64', totalmem: () => 256 * GiB, freemem: () => 200 * GiB,
    parallelism: () => 64, read: file => {if (!(file in files)) throw new Error('missing'); return files[file];}});
  assert.equal(result.memoryBytes, 8 * GiB); assert.equal(result.availableMemoryBytes, 5 * GiB);
  assert.equal(result.memorySource, 'cgroup_v2'); assert.equal(result.cpuCount, 2);
  assert.equal(result.scope, 'desktop_process'); assert.equal(result.gpu, 'unknown');
  assert.equal(JSON.stringify(result).includes('/sys/'), false);
});

test('unavailable or unsafe resource namespace never falls back to misleading physical RAM', () => {
  for (const group of ['0::/../../host', '0::/unknown']) {
    const result = hostInfo({platform: 'linux', totalmem: () => 256 * 1024 ** 3,
      read: file => file === '/proc/self/cgroup' ? group : '36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw'});
    assert.equal(result.memoryBytes, null); assert.equal(result.memorySource, 'unknown');
  }
});

test('source/license link resolution is restricted to packaged entry and fixed HTTPS origin', () => {
  const h = harness();
  assert.equal(h.service.catalogLink({catalogId: entry.id, kind: 'source'}), entry.sourceUrl);
  assert.equal(h.service.catalogLink({catalogId: entry.id, kind: 'license'}), entry.license.url);
  for (const input of [{catalogId: entry.id, kind: 'file'}, {catalogId: 'not-present', kind: 'source'},
    {catalogId: entry.id, kind: 'source', url: 'file:///private'}, null]) assert.equal(h.service.catalogLink(input), null);
  for (const sourceUrl of ['file:///private', 'https://evil.invalid/library/a', 'https://u:p@ollama.com/library/a',
    'https://ollama.com/library/a?secret', 'https://ollama.com/library/a#secret']) {
    const source = structuredClone(manifest); source.entries[0].sourceUrl = sourceUrl;
    assert.equal(harness({source}).service.catalogLink({catalogId: entry.id, kind: 'source'}), null);
  }
});

test('start rechecks installed tags before mutation to avoid stale-inspection overwrite', async () => {
  const h = harness(); const inspection = await h.prepare(); h.setInventory([installed()]);
  const started = h.service.start({inspectionId: inspection.inspectionId, catalogId: entry.id, downloadConsent: true});
  assert.equal(started.ok, true); await next();
  assert.equal(h.calls.some(call => call.path === '/api/pull'), false);
  assert.equal(h.service.status().job.error_code, 'catalog_already_installed');
  assert.equal(h.service.status().job.serverState, 'terminal');
});

test('cancel before the pull request is actually dispatched is safely terminal', async () => {
  const h = harness(); const inspection = await h.prepare();
  const started = h.service.start({inspectionId: inspection.inspectionId, catalogId: entry.id, downloadConsent: true});
  h.service.cancel({jobId: started.job.id}); await next();
  assert.equal(h.calls.some(call => call.path === '/api/pull'), false);
  assert.equal(h.service.status().job.error_code, 'catalog_cancelled_before_download');
  assert.equal(h.service.status().job.canRetry, true); assert.equal(h.service.status().job.serverState, 'terminal');
});

test('controlled localhost fixture verifies real HTTP NDJSON split delivery without Ollama or model blobs', async t => {
  const http = require('node:http');
  const seen = []; let pulled = false;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => {body += chunk;}); req.on('end', () => {
      seen.push({method: req.method, path: req.url, body});
      if (req.url === '/api/version') {res.setHeader('content-type', 'application/json'); res.end('{"version":"0.13.1"}');}
      else if (req.url === '/api/tags') {res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({models: pulled ? [installed()] : []}));}
      else if (req.url === '/api/show') {res.setHeader('content-type', 'application/json'); res.end('{"capabilities":["completion","vision"]}');}
      else if (req.url === '/api/pull') {
        assert.deepEqual(JSON.parse(body), {model: entry.model, stream: true}); pulled = true;
        res.setHeader('content-type', 'application/x-ndjson'); res.write('{"status":"pull');
        setImmediate(() => res.end('ing manifest"}\n{"status":"success"}\n'));
      } else {res.statusCode = 404; res.end();}
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = createModelCatalog({deviceInfo: () => fakeDevice, readJournal: () => null, writeJournal() {}});
  const inspected = await service.inspect({protocol: 'ollama_native', endpoint: `http://127.0.0.1:${server.address().port}`});
  assert.equal(inspected.ok, true);
  assert.equal(service.start({inspectionId: inspected.inspectionId, catalogId: entry.id, downloadConsent: true}).ok, true);
  const deadline = Date.now() + 2000;
  while (['starting', 'downloading', 'verifying'].includes(service.status().job.state) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.status().job.state, 'succeeded');
  assert.ok(seen.every(request => ['/api/version', '/api/tags', '/api/show', '/api/pull'].includes(request.path)));
  assert.equal(seen.filter(request => request.path === '/api/pull').length, 1);
});

test('atomic journal roundtrip is bounded; corrupt and stale temporary records fail closed', t => {
  const os = require('node:os'); const {createJournal} = require('../src/model-catalog-journal.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openbutler-catalog-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const journal = createJournal(() => directory);
  assert.equal(journal.readJournal(), null);
  journal.writeJournal({synthetic: true}); assert.deepEqual(journal.readJournal(), {synthetic: true});
  journal.writeJournal({synthetic: 'next'}); assert.deepEqual(journal.readJournal(), {synthetic: 'next'});
  fs.writeFileSync(path.join(directory, 'model-catalog-download.json'), 'x'.repeat(4097));
  assert.throws(() => journal.readJournal(), /journal_unavailable/);
  fs.writeFileSync(path.join(directory, 'model-catalog-download.json.pending'), 'retained evidence');
  assert.throws(() => journal.writeJournal({synthetic: true}));
});

test('fresh explicit inspected absence permits recovery from terminal verification failure, not old tokens', async () => {
  const h = harness({stream: [{status: 'success'}]}); const inspection = await h.prepare();
  const start = () => h.service.start({inspectionId: inspection.inspectionId, catalogId: entry.id, downloadConsent: true});
  assert.equal(start().ok, true); await next();
  assert.equal(h.service.status().job.state, 'failed'); assert.equal(h.service.status().job.canRetry, false);
  assert.equal(start().error_code, 'catalog_reinspection_required');
  h.tick(); const fresh = await h.prepare();
  assert.equal(h.service.start({inspectionId: fresh.inspectionId, catalogId: entry.id, downloadConsent: true}).ok, true);
  await next(); assert.equal(h.calls.filter(call => call.path === '/api/pull').length, 2);
});

test('real cgroup-v2 hierarchy root without memory.max retains restrictive child/ancestor limits', () => {
  const GiB = 1024 ** 3;
  const files = {'/proc/self/cgroup': '0::/parent/child',
    '/proc/self/mountinfo': '36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
    '/sys/fs/cgroup/parent/child/memory.max': String(16 * GiB), '/sys/fs/cgroup/parent/child/memory.current': String(GiB),
    '/sys/fs/cgroup/parent/memory.max': String(8 * GiB), '/sys/fs/cgroup/parent/memory.current': String(3 * GiB),
    '/sys/fs/cgroup/cpuset.cpus.isolated': '', '/sys/fs/cgroup/cgroup.controllers': 'cpuset cpu io memory pids'};
  const missing = () => Object.assign(new Error('not found'), {code: 'ENOENT'});
  const result = hostInfo({platform: 'linux', totalmem: () => 256 * GiB, freemem: () => 200 * GiB,
    read: file => {if (!(file in files)) throw missing(); return files[file];}});
  assert.equal(result.memoryBytes, 8 * GiB); assert.equal(result.availableMemoryBytes, 5 * GiB);
  assert.equal(result.memorySource, 'cgroup_v2');
});

test('missing child limits, permission failures and virtual root without root-only evidence stay unknown', () => {
  const GiB = 1024 ** 3;
  for (const variant of ['missing-child', 'root-permission-denied', 'virtual-root', 'no-memory-controller', 'malformed-root-marker']) {
    const files = {'/proc/self/cgroup': '0::/child',
      '/proc/self/mountinfo': '36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
      '/sys/fs/cgroup/child/memory.max': String(8 * GiB), '/sys/fs/cgroup/child/memory.current': String(3 * GiB),
      '/sys/fs/cgroup/cpuset.cpus.isolated': '', '/sys/fs/cgroup/cgroup.controllers': 'cpuset cpu memory'};
    if (variant === 'missing-child') delete files['/sys/fs/cgroup/child/memory.max'];
    if (variant === 'virtual-root') delete files['/sys/fs/cgroup/cpuset.cpus.isolated'];
    if (variant === 'no-memory-controller') files['/sys/fs/cgroup/cgroup.controllers'] = 'cpuset cpu';
    if (variant === 'malformed-root-marker') files['/sys/fs/cgroup/cpuset.cpus.isolated'] = 'unknown';
    const result = hostInfo({platform: 'linux', totalmem: () => 256 * GiB, freemem: () => 200 * GiB,
      read: file => {
        if (!(file in files)) throw Object.assign(new Error('not found'), {
          code: variant === 'root-permission-denied' && file === '/sys/fs/cgroup/memory.max' ? 'EACCES' : 'ENOENT'});
        return files[file];
      }});
    assert.equal(result.memoryBytes, null, variant); assert.equal(result.memorySource, 'unknown', variant);
  }
});

test('direct real hierarchy root process reports physical RAM only with root-only evidence', () => {
  const files = {'/proc/self/cgroup': '0::/',
    '/proc/self/mountinfo': '36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
    '/sys/fs/cgroup/cpuset.cpus.isolated': '2-3,7', '/sys/fs/cgroup/cgroup.controllers': 'cpuset cpu memory'};
  const result = hostInfo({platform: 'linux', totalmem: () => 16 * 1024 ** 3, freemem: () => 8 * 1024 ** 3,
    read: file => {if (!(file in files)) throw Object.assign(new Error(), {code: 'ENOENT'}); return files[file];}});
  assert.equal(result.memoryBytes, 16 * 1024 ** 3); assert.equal(result.memorySource, 'physical');
});
