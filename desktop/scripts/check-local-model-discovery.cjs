'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const {createLocalModelDiscovery, localEndpoint, installedIds, installedMetadata, LIMITS} = require('../src/local-model-discovery.cjs');
const input = {endpoint: 'http://localhost:11435', protocol: 'ollama_native'};
const tags = {models: [{name: 'qwen3.5:2b', model: 'qwen3.5:2b', size: 4096, digest: 'a'.repeat(64),
  details: {format: 'gguf', ignored: 'untrusted metadata'}}]};

function transport({status = 200, headers = {}, chunks = [Buffer.from(JSON.stringify(tags))], hold = false,
  error = false} = {}) {
  const calls = [], requests = [], responses = [];
  const request = (options, callback) => {
    calls.push(options);
    const req = new EventEmitter(); requests.push(req);
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      if (hold) return;
      queueMicrotask(() => {
        if (error) { req.emit('error', new Error('private-token-exception-must-not-leak')); return; }
        const res = new EventEmitter(); responses.push(res);
        res.statusCode = status; res.headers = {'content-type': 'application/json', ...headers};
        res.destroy = () => { res.destroyed = true; };
        callback(res);
        for (const chunk of chunks) if (!res.destroyed) res.emit('data', chunk);
        if (!res.destroyed) res.emit('end');
      });
    };
    return req;
  };
  return {request, calls, requests, responses};
}

test('literal loopback endpoint semantics match native local gateway and pin localhost', () => {
  for (const endpoint of ['http://localhost:11435', 'http://127.0.0.1:11435', 'http://127.22.3.4',
    'http://[::1]:11435', 'http://[0:0:0:0:0:0:0:1]:80']) {
    assert.equal(localEndpoint(endpoint).endpoint, endpoint);
  }
  assert.equal(localEndpoint(input.endpoint).address, '127.0.0.1');
  for (const endpoint of ['', ' http://localhost:11435', 'https://localhost:11435',
    'http://localhost:11435/', 'http://localhost:11435/api', 'http://user:pass@localhost:11435',
    'http://localhost:11435?token=private', 'http://localhost:11435#fragment',
    'http://localhost.evil:11435', 'http://127.1:11435', 'http://0177.0.0.1:11435',
    'http://2130706433:11435', 'http://0x7f000001:11435', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://[::ffff:127.0.0.1]:11435', 'http://[::]:11435',
    'http://192.168.1.1:11435', 'http://8.8.8.8:11435', 'http://localhost\\@evil',
    'http://local%68ost:11435', 'http://localhost:11435\r\nX-Key:secret']) {
    assert.throws(() => localEndpoint(endpoint), /invalid_local_endpoint/, endpoint);
  }
});

test('one exact unauthenticated GET only, no proxy agent or cookie context', async () => {
  const t = transport(); const list = createLocalModelDiscovery(t);
  assert.deepEqual(await list(input), {ok: true, models: ['qwen3.5:2b'], endpoint: input.endpoint,
    modelMetadata: [{name: 'qwen3.5:2b', locality: 'local'}]});
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], {protocol: 'http:', hostname: '127.0.0.1', port: 11435,
    method: 'GET', path: '/api/tags', agent: false, maxHeaderSize: 8192,
    headers: {Accept: 'application/json', Host: 'localhost:11435', Connection: 'close'}});
  assert.equal(t.requests[0].destroyed, true);
});

test('invalid endpoint or protocol is rejected before any request or endpoint reflection', async () => {
  const t = transport(), list = createLocalModelDiscovery(t);
  assert.equal((await list({...input, protocol: 'openai_compatible'})).error_code, 'unsupported_discovery_protocol');
  const result = await list({...input, endpoint: 'http://private:secret@evil.example'});
  assert.equal(result.error_code, 'invalid_local_endpoint'); assert.equal(result.endpoint, '');
  assert.equal(t.calls.length, 0); assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('redirects and HTTP errors never follow a location or expose server contents', async () => {
  for (const status of [301, 302, 307, 308, 401, 404, 500]) {
    const t = transport({status, headers: {location: 'http://remote.invalid/private'}});
    const result = await createLocalModelDiscovery(t)(input);
    assert.equal(result.error_code, 'local_discovery_http_error'); assert.deepEqual(result.models, []);
    assert.equal(t.calls.length, 1); assert.equal(JSON.stringify(result).includes('remote.invalid'), false);
  }
});

test('enforces both announced and streaming byte bounds', async () => {
  for (const options of [
    {headers: {'content-length': String(LIMITS.responseBytes + 1)}},
    {chunks: [Buffer.alloc(LIMITS.responseBytes), Buffer.from('x')]},
  ]) {
    const t = transport(options), result = await createLocalModelDiscovery(t)(input);
    assert.equal(result.error_code, 'local_discovery_response_too_large');
    assert.equal(t.requests[0].destroyed, true); assert.equal(t.responses[0].destroyed, true);
  }
});

test('requires bounded plain JSON with valid UTF-8, not encoded or other-content responses', async () => {
  for (const options of [{headers: {'content-type': 'text/html'}}, {headers: {'content-encoding': 'gzip'}},
    {chunks: [Buffer.from([0xc3, 0x28])]}, {chunks: [Buffer.from('not json')]}, {chunks: []}]) {
    assert.equal((await createLocalModelDiscovery(transport(options))(input)).error_code, 'invalid_local_model_response');
  }
});

test('returns only declared-local exact names and marks ambiguous duplicates or missing metadata unknown', () => {
  assert.deepEqual(installedIds(tags), ['qwen3.5:2b']);
  const result = installedIds({models: [...tags.models, ...tags.models, {name: 'team/model:tag-v2'}]});
  assert.deepEqual(result, []);
  assert.deepEqual(installedIds({models: []}), []);
});

test('preserves bounded cloud and remote alias metadata without offering them as local models', async () => {
  const models = [...tags.models, {name: 'friendly-alias:latest', model: 'friendly-alias:latest',
    remote_model: 'large:cloud', remote_host: 'https://ollama.com', details: {ignored: 'do not expose'}},
    {name: 'name-only:latest'}, {...tags.models[0], name: 'large:cloud', model: 'large:cloud'}];
  const result = await createLocalModelDiscovery(transport({chunks: [Buffer.from(JSON.stringify({models}))]}))(input);
  assert.deepEqual(result.models, ['qwen3.5:2b']);
  assert.deepEqual(result.modelMetadata, [{name: 'qwen3.5:2b', locality: 'local'},
    {name: 'friendly-alias:latest', locality: 'remote', remote_model: 'large:cloud', remote_host: 'https://ollama.com'},
    {name: 'name-only:latest', locality: 'unknown'}, {name: 'large:cloud', locality: 'remote'}]);
  assert.equal(JSON.stringify(result).includes('do not expose'), false);
});

test('malformed remote metadata and credential-bearing hosts are never reflected', () => {
  for (const metadata of [{remote_model: null}, {remote_host: false},
    {remote_host: 'https://private:secret@example.test'}, {remote_host: 'https://example.test?token=secret'},
    {remote_host: 'https://example.test#secret'}, {remote_model: 'x\nsecret'}, {remote_host: 'file:///secret'}]) {
    assert.throws(() => installedMetadata({models: [{...tags.models[0], ...metadata}]}));
  }
});

test('malformed or ambiguous provider model IDs reject the whole response', () => {
  for (const name of ['', ' ', ' qwen3:2b', 'qwen3:2b ', 'a\nb', '<script>', '\u202eprivate',
    '../name', 'team/../name', 'team//name', 'x?prompt=secret', 'a'.repeat(201)]) {
    assert.throws(() => installedIds({models: [{name}]}), /invalid_local_model_response/);
  }
  for (const value of [{models: [{name: 'a', model: 'b'}]}, {models: [null]}, {models: ['a']},
    {models: Array.from({length: 129}, () => ({name: 'a'}))}, [], {}, {models: {name: 'a'}}]) {
    assert.throws(() => installedIds(value), /invalid_local_model_response/);
  }
});

test('total deadline covers a stalled transport; concurrent click is bounded', async () => {
  const t = transport({hold: true}), list = createLocalModelDiscovery({...t, timeoutMs: 15});
  const first = list(input);
  assert.equal((await list(input)).error_code, 'local_discovery_busy');
  assert.equal((await first).error_code, 'local_discovery_timeout');
  assert.equal(t.calls.length, 1); assert.equal(t.requests[0].destroyed, true);
  assert.equal((await list(input)).error_code, 'local_discovery_timeout');
  assert.equal(t.calls.length, 2);
});

test('transport exceptions map to a fixed code without raw details', async () => {
  const result = await createLocalModelDiscovery(transport({error: true}))(input);
  assert.equal(result.error_code, 'local_discovery_unavailable');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});
