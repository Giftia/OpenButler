'use strict';
// Synthetic metadata only: no X11 connection, window capture, model or network.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const {PublicWindowProvider, sourceRevision} = require('../src/public-window-provider.cjs');
const reasons = ['not_viewable', 'not_standard_window', 'unsupported_format', 'bordered_window',
  'invalid_size', 'identity_unavailable', 'unknown_error'];
const counts = (values = {}) => ({rejected_counts: {...Object.fromEntries(reasons.map(key => [key, 0])), ...values}});
const identity = {window_id: 'x11:123', owner_pid: 456, owner_process_start: '789',
  owner_process_name: 'test-app', wm_class: 'Test', window_title: 'Public test',
  content_bounds: {x: 10, y: 20, width: 4, height: 3}};
const expectedSources = [{id: identity.window_id, label: identity.window_title, source_identity: identity}];
function providerFor(response) {
  const calls = [], provider = new PublicWindowProvider();
  provider.request = async command => { calls.push(command); return response; };
  return {provider, calls};
}

test('legacy helper response and array callers retain exact accepted sources and revision', async () => {
  const {provider, calls} = providerFor({sources: [identity]});
  assert.deepEqual(await provider.listSourcesResult(), {sources: expectedSources});
  assert.deepEqual(await provider.listSources(), expectedSources);
  assert.deepEqual(calls, [{action: 'list'}, {action: 'list'}]);
  assert.equal(sourceRevision((await provider.listSources())[0].source_identity), sourceRevision(identity));
});

test('optional bounded diagnostics do not change accepted identities or old caller result', async () => {
  const diagnostics = counts({unsupported_format: 2, not_viewable: 1});
  const {provider} = providerFor({sources: [identity], diagnostics, rejected_title: 'PRIVATE_SENTINEL'});
  assert.deepEqual(await provider.listSourcesResult(), {sources: expectedSources, diagnostics});
  assert.deepEqual(await provider.listSources(), expectedSources);
  assert.equal(JSON.stringify(await provider.listSourcesResult()).includes('PRIVATE_SENTINEL'), false);
});

test('malformed diagnostics are discarded without changing eligible sources or leaking fields', async () => {
  const invalid = [null, [], 'PRIVATE_SENTINEL', {}, {rejected_counts: {}},
    {...counts(), window_title: 'PRIVATE_SENTINEL'}, counts({unknown_key: 'PRIVATE_SENTINEL'}),
    counts({not_viewable: -1}), counts({not_viewable: 201}), counts({not_viewable: 0.5}),
    counts({not_viewable: '2'}), counts({not_viewable: true}), counts({not_viewable: NaN}),
    counts({not_viewable: Infinity}), counts({not_viewable: Number.MAX_SAFE_INTEGER}),
    counts({not_viewable: 100, unsupported_format: 100}),
    {rejected_counts: Object.create(counts().rejected_counts)}];
  for (const diagnostics of invalid) {
    const {provider} = providerFor({sources: [identity], diagnostics});
    assert.deepEqual(await provider.listSourcesResult(), {sources: expectedSources});
  }
});

test('candidate limit includes eligible and rejected counts, including empty and exact bounds', async () => {
  for (const [sources, diagnostics, valid] of [
    [[], counts(), true], [[], counts({unsupported_format: 200}), true],
    [[identity], counts({unsupported_format: 199}), true],
    [[identity], counts({unsupported_format: 200}), false],
    [[], counts({unsupported_format: 199, not_viewable: 2}), false],
  ]) {
    const {provider} = providerFor({sources, diagnostics});
    const result = await provider.listSourcesResult();
    assert.equal(Object.hasOwn(result, 'diagnostics'), valid);
  }
});

test('invalid accepted identity still fails closed, never converted into a selectable source', async () => {
  const {provider} = providerFor({sources: [{...identity, owner_pid: 0}], diagnostics: counts()});
  await assert.rejects(provider.listSourcesResult(), /invalid_window_identity/);
  await assert.rejects(provider.listSources(), /invalid_window_identity/);
});

test('each refresh returns only its own diagnostics without retained history', async () => {
  const {provider, calls} = providerFor(null);
  const responses = [{sources: [], diagnostics: counts({unsupported_format: 2})},
    {sources: [], diagnostics: counts()}, {sources: []}];
  provider.request = async command => { calls.push(command); return responses.shift(); };
  assert.equal((await provider.listSourcesResult()).diagnostics.rejected_counts.unsupported_format, 2);
  assert.deepEqual((await provider.listSourcesResult()).diagnostics, counts());
  assert.equal(Object.hasOwn(await provider.listSourcesResult(), 'diagnostics'), false);
  assert.deepEqual(calls, [{action: 'list'}, {action: 'list'}, {action: 'list'}]);
  assert.equal(Object.keys(provider).some(key => /diagnostic|rejected|history/i.test(key)), false);
});

test('actual native list serialization crosses existing provider protocol without private candidate text', async () => {
  const helper = path.resolve(__dirname, '../src/x11-public-window.py');
  const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('source', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = module.X11WindowSource.__new__(module.X11WindowSource)
source.clients = lambda: [123, 456, 789]
def identity(window):
    if window == 123: return json.loads(sys.argv[2])
    if window == 456: raise module.DiscoveryRejection('unsupported_format')
    raise ValueError('PRIVATE_REJECTED_TITLE_PATH_ID')
source.identity = identity
result, pixels = source.command({'action': 'list'})
assert pixels is None
print(json.dumps({'ok': True, **result}))`;
  const serialized = execFileSync(process.env.OPENBUTLER_PYTHON || 'python3',
    ['-B', '-c', script, helper, JSON.stringify(identity)],
    {encoding: 'utf8', env: {...process.env, DISPLAY: '', XDG_SESSION_TYPE: '', PYTHONDONTWRITEBYTECODE: '1'}});
  assert.equal(serialized.includes('PRIVATE_REJECTED_TITLE_PATH_ID'), false);
  const commands = [], logs = [];
  let child;
  const provider = new PublicWindowProvider({spawnProcess: () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    child.stdin = {write(command) { commands.push(JSON.parse(command));
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(serialized))); }};
    return child;
  }});
  provider.available = () => true;
  const warn = console.warn; console.warn = (...args) => logs.push(args);
  try {
    assert.deepEqual(await provider.listSourcesResult(), {sources: expectedSources,
      diagnostics: counts({unsupported_format: 1, unknown_error: 1})});
    assert.deepEqual(commands, [{action: 'list'}]);
    assert.deepEqual(logs, []);
  } finally { console.warn = warn; provider.close(); }
});

test('Windows provider inherits result and legacy array compatibility without native diagnostics', async () => {
  const {WindowsPublicWindowProvider} = require('../src/windows-public-window-provider.cjs');
  const provider = new WindowsPublicWindowProvider();
  const windowsIdentity = {...identity, window_id: 'hwnd:123'};
  const commands = [];
  provider.request = async command => { commands.push(command); return {sources: [windowsIdentity]}; };
  const sources = [{id: windowsIdentity.window_id, label: windowsIdentity.window_title, source_identity: windowsIdentity}];
  assert.deepEqual(await provider.listSourcesResult(), {sources});
  assert.deepEqual(await provider.listSources(), sources);
  assert.deepEqual(commands, [{action: 'list'}, {action: 'list'}]);
});
