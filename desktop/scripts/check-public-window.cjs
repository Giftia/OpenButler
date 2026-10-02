'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {PNG} = require('pngjs');
const {PublicWindowController, publicConfig} = require('../src/public-window-controller.cjs');
const {PublicWindowProvider, sourceRevision} = require('../src/public-window-provider.cjs');

const identity = {window_id: 'x11:123', owner_pid: 456, owner_process_start: '789',
  owner_process_name: 'mousepad', wm_class: 'mousepad:Mousepad', window_title: '*public.txt - Mousepad',
  content_bounds: {x: 10, y: 20, width: 40, height: 30}};
const config = {capture_scope: 'dedicated_public_window', display_id: 'x11:123',
  source_identity: identity, excluded_apps: ['password-manager'], masks: [],
  session_duration_seconds: 60, interval_seconds: 10};
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {resolve, promise}; };
function fixture() {
  const calls = {posts: [], configure: [], starts: 0, pauses: 0, acquires: 0};
  const png = new PNG({width: 40, height: 30}); png.data.fill(255);
  let now = Date.parse('2026-10-02T06:00:00Z');
  let current = structuredClone(identity), foreground = structuredClone(identity), raw;
  const provider = {bind: async () => {}, prepareSource: async () => {}, close: () => {}, inspect: async () => ({
    source_identity: current, foreground_identity: foreground, lock_state: 'unknown', lock_protection_supported: false}),
  acquireFrame: async () => { calls.acquires++; raw = PNG.sync.write(png); return {
    buffer: raw, source_identity: current, capture_method: 'xcomposite_named_window_pixmap',
    captured_at_ms: now, content_nonblack: true, source_verified_before: true, source_verified_after: true}; }};
  const c = new PublicWindowController({provider, clock: () => now,
    ocr: {recognize: async () => ({text: 'PUBLIC WORK', words: [
      {text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]})},
    configureBackend: async body => { calls.configure.push(body); return {consent_revision: '12345678-1234-1234-1234-123456789012'}; },
    startBackendCapture: async () => { calls.starts++; }, pauseBackendCapture: async () => { calls.pauses++; },
    postObservation: async body => { calls.posts.push(body); return {recorded: true}; }});
  return {c, provider, calls, raw: () => raw, advance: ms => { now += ms; },
    identity: value => { current = value; }, foreground: value => { foreground = value; }};
}

test('public scope cannot be selected by an incomplete or desktop config', () => {
  assert.throws(() => publicConfig({...config, capture_scope: undefined}), /invalid_public_window_scope/);
  assert.throws(() => publicConfig({...config, display_id: 'screen:0'}), /source_binding_mismatch/);
  assert.throws(() => publicConfig({...config, interval_seconds: 1}), /invalid_capture_interval/);
  assert.throws(() => publicConfig({...config, session_duration_seconds: 3601}), /invalid_session_duration/);
  assert.throws(() => publicConfig({...config, masks: [{x: 39, y: 0, width: 2, height: 1}]}), /invalid_capture_mask/);
});

test('one-time preview binds source identity, masks, interval and session duration', async () => {
  const {c, calls, raw} = fixture();
  await assert.rejects(c.start(config), /privacy_preview_required/);
  await c.previewMasked(config);
  assert.ok(raw().every(value => value === 0));
  await assert.rejects(c.start({...config, interval_seconds: 30}), /privacy_preview_required/);
  await c.start(config);
  assert.equal(c.state().lock_state, 'unknown');
  assert.equal(calls.configure[0].sampling_interval_ms, 10000);
  await c.captureOnce();
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].source_kind, 'public_window');
  assert.equal(calls.posts[0].session_expires_at, calls.configure[0].session_expires_at);
  assert.equal(calls.posts[0].source_revision, sourceRevision(identity));
  assert.equal(calls.posts[0].sampling_sequence, 1);
  assert.equal('local_ocr_text' in calls.posts[0], false);
  await c.pause();
  await assert.rejects(c.start(config), /privacy_preview_required/);
});

test('excluded foreground acquires zero pixels; other known foreground is allowed', async () => {
  const f = fixture();
  f.foreground({...identity, owner_process_name: 'password-manager'});
  await assert.rejects(f.c.previewMasked(config), /application_excluded_or_unknown/);
  assert.equal(f.calls.acquires, 0);
  f.foreground({...identity, owner_process_name: 'openbutler', wm_class: 'OpenButler', window_title: 'OpenButler'});
  assert.equal((await f.c.previewMasked(config)).ok, true);
  await f.c.pause();
});

test('post-acquisition identity loss drops pixels and retains no preview', async () => {
  const f = fixture();
  f.c.ocr.recognize = async () => {
    f.identity({...identity, window_title: 'another-document.txt'});
    return {text: 'PUBLIC', words: [{text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]};
  };
  await assert.rejects(f.c.previewMasked(config), /source_binding_mismatch/);
  assert.equal(f.c.preview, null); assert.equal(f.calls.posts.length, 0);
  assert.ok(f.raw().every(value => value === 0));
});

test('black or textless initialized frames fail without preview, post, or retained helper', async () => {
  for (const kind of ['black', 'textless']) {
    const f = fixture(); let closes = 0; f.provider.close = () => { closes++; };
    if (kind === 'black') {
      const acquire = f.provider.acquireFrame;
      f.provider.acquireFrame = async () => ({...await acquire(), content_nonblack: false});
    } else f.c.ocr.recognize = async () => ({text: '', words: []});
    await assert.rejects(f.c.previewMasked(config), /window_repaint/);
    assert.equal(closes, 1); assert.equal(f.c.preview, null); assert.equal(f.calls.posts.length, 0);
    assert.ok(f.raw().every(value => value === 0));
  }
});

test('preview lifetime starts before OCR and cancels a late result after helper cleanup', async () => {
  const f = fixture(), waiting = deferred(); let expire; let closes = 0;
  f.provider.close = () => { closes++; };
  f.c.ocr.recognize = () => waiting.promise;
  const originalTimeout = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 300000) { expire = callback; return 987654; }
    return originalTimeout(callback, delay, ...args);
  };
  const preview = f.c.previewMasked(config);
  global.setTimeout = originalTimeout;
  assert.equal(typeof expire, 'function');
  await new Promise(resolve => originalTimeout(resolve, 230));
  expire();
  assert.equal(closes, 1); assert.equal(f.c.lastResult, 'privacy_preview_expired');
  waiting.resolve({text: 'PUBLIC', words: [{text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]});
  await assert.rejects(preview, /preview_cancelled/);
  assert.equal(f.c.preview, null); assert.ok(f.raw().every(value => value === 0));
});

test('source loss during recording stops instead of silently skipping and resuming', async () => {
  const f = fixture(); await f.c.previewMasked(config); await f.c.start(config);
  f.provider.inspect = async () => { throw new Error('window_destroyed_unmapped_or_reconfigured'); };
  const result = await f.c.captureOnce();
  assert.equal(result.recorded, false); assert.equal(f.c.active, false);
  assert.equal(f.calls.posts.length, 0);
  await assert.rejects(f.c.start(config), /privacy_preview_required/);
});

test('pause cancels an in-flight preview and blocks simultaneous preview', async () => {
  const f = fixture(), waiting = deferred();
  f.provider.bind = () => waiting.promise;
  const preview = f.c.previewMasked(config);
  await assert.rejects(f.c.previewMasked(config), /capture_already_active/);
  await f.c.pause(); waiting.resolve();
  await assert.rejects(preview, /preview_cancelled/);
  assert.equal(f.c.preview, null); assert.equal(f.calls.acquires, 0);
});

for (const phase of ['inspect', 'configureBackend', 'startBackendCapture']) {
  test(`pause during start ${phase} never activates or installs timers`, async () => {
    const f = fixture(), waiting = deferred();
    await f.c.previewMasked(config);
    if (phase === 'inspect') {
      const original = f.c.inspect.bind(f.c);
      f.c.inspect = async value => { await waiting.promise; return original(value); };
    } else {
      const original = f.c[phase].bind(f.c);
      f.c[phase] = async value => { await waiting.promise; return original(value); };
    }
    const starting = f.c.start(config); await tick();
    await assert.rejects(f.c.start(config), /capture_already_active/);
    await f.c.pause(); waiting.resolve();
    await assert.rejects(starting, /capture_cancelled/);
    assert.equal(f.c.active, false); assert.equal(f.c.timer, null);
  });
}

test('paused capture after OCR never sends; paused post completion preserves stopped state', async () => {
  const f = fixture(); await f.c.previewMasked(config); await f.c.start(config);
  const waiting = deferred(); f.c.postObservation = async () => waiting.promise;
  const capture = f.c.captureOnce(); await tick();
  await f.c.pause('user_paused'); waiting.resolve({recorded: true}); await capture;
  assert.equal(f.c.lastResult, 'user_paused'); assert.equal(f.c.active, false);
});

test('session expiry stops before acquisition and requires another preview', async () => {
  const f = fixture(); await f.c.previewMasked(config); await f.c.start(config);
  f.advance(61_000); const before = f.calls.acquires;
  assert.equal((await f.c.captureOnce()).reason, 'session_expired');
  assert.equal(f.calls.acquires, before); assert.equal(f.c.active, false);
});

test('stale guard rejection cannot cancel a newer reviewed preview', async () => {
  const f = fixture(), intervals = [];
  await f.c.previewMasked(config);
  const originalInterval = global.setInterval;
  global.setInterval = callback => { intervals.push(callback); return 9000 + intervals.length; };
  try { await f.c.start(config); } finally { global.setInterval = originalInterval; }
  const inspect = f.c.inspect.bind(f.c);
  let rejectGuard;
  f.c.inspect = () => new Promise((_resolve, reject) => { rejectGuard = reject; });
  intervals[1]();
  f.c.inspect = inspect;
  await f.c.pause('user_paused');
  await f.c.previewMasked(config);
  const reviewed = f.c.preview;
  rejectGuard(new Error('old_guard_failed'));
  await tick();
  assert.equal(f.c.preview, reviewed);
  assert.equal(f.calls.pauses, 1);
  assert.notEqual(f.c.lastResult, 'old_guard_failed');
  await f.c.pause();
});

test('provider close invalidates queued commands and ignores stale child bytes', async () => {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter();
    child.stdin = {write() {}}; child.kill = () => {}; children.push(child); return child;
  };
  const provider = new PublicWindowProvider({spawnProcess}); provider.available = () => true;
  const first = provider.request({action: 'inspect'}), second = provider.request({action: 'capture'});
  const results = Promise.allSettled([first, second]); await tick(); provider.close(); await results;
  assert.equal(children.length, 1); assert.equal(provider.pending, null);
  const third = provider.request({action: 'list'}); await tick();
  const stale = Buffer.from('{"ok":true,"sources":[]}\n'); children[0].stdout.emit('data', stale);
  assert.ok(stale.every(value => value === 0)); assert.ok(provider.pending);
  children[1].stdout.emit('data', Buffer.from('{"ok":true,"sources":[]}\n'));
  assert.deepEqual((await third).sources, []); provider.close();
});

test('native acquisition has one named-client drawable read and no pixel fallback', () => {
  const native = fs.readFileSync(path.join(__dirname, '../src/x11-public-window.py'), 'utf8');
  assert.equal((native.match(/self\.x\.XGetImage\(self\.d, pixmap,/g) || []).length, 1);
  assert.equal(/self\.x\.XGetImage\(self\.d, (?:self\.root|window)/.test(native), false);
  assert.equal(/\.XCompositeRedirectSubwindows\(/.test(native), false);
  assert.equal(/\.XCompositeRedirectWindow\(self\.d, window, 0\)/.test(native), true);
  assert.equal(/\.XClearArea\(/.test(native), false);
  assert.equal(/ImageGrab|desktopCapturer|\.save\([^o]/.test(native), false);
  assert.ok(native.includes('kind == 28 and event[5] in self.identity_atoms'));
});

test('observation mode defaults to vision, rejects unknown modes and invalidates old preview', async () => {
  const f = fixture();
  assert.equal(publicConfig(config).observation_mode, 'vision');
  assert.throws(() => publicConfig({...config, observation_mode: 'auto'}), /invalid_observation_mode/);
  await f.c.previewMasked(config);
  await assert.rejects(f.c.start({...config, observation_mode: 'masked_ocr_text'}), /privacy_preview_required/);
  await f.c.start(config); await f.c.captureOnce();
  assert.equal(f.calls.posts[0].observation_mode, 'vision');
  assert.equal(Object.keys(f.calls.posts[0]).some(key => key.startsWith('post_mask_ocr')), false);
  await f.c.pause();
});

test('OCR route recognizes final masked pixels afresh and binds exact posted PNG, never first-pass text', async () => {
  const f = fixture(), images = [];
  const ocrConfig = {...config, observation_mode: 'masked_ocr_text', masks: [{x: 0, y: 0, width: 8, height: 8}]};
  f.c.ocr.recognize = async buffer => {
    images.push(Buffer.from(buffer));
    const second = images.length % 2 === 0;
    const pixels = PNG.sync.read(buffer);
    assert.equal(pixels.data[0], second ? 0 : 255);
    return {text: second ? 'SAFE PUBLIC POST MASK TEXT\n' : 'RAW PRE MASK TEXT', words: [
      {text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]};
  };
  const preview = await f.c.previewMasked(ocrConfig);
  assert.equal(preview.observation_mode, 'masked_ocr_text');
  assert.equal(preview.post_mask_ocr_text, 'SAFE PUBLIC POST MASK TEXT\n');
  assert.equal(JSON.stringify(preview).includes('RAW PRE MASK'), false);
  await f.c.start(ocrConfig); await f.c.captureOnce();
  assert.equal(images.length, 4);
  const payload = f.calls.posts[0], posted = Buffer.from(payload.masked_png_base64, 'base64');
  assert.ok(posted.equals(images[3]));
  assert.equal(payload.post_mask_ocr_image_digest, require('node:crypto').createHash('sha256').update(posted).digest('hex'));
  assert.equal(payload.post_mask_ocr_complete, true); assert.equal(payload.post_mask_ocr_engine, 'tesseract.js');
  assert.equal(payload.post_mask_ocr_text, 'SAFE PUBLIC POST MASK TEXT\n');
  assert.equal(JSON.stringify(payload).includes('RAW PRE MASK'), false);
  assert.equal(f.calls.configure[0].observation_mode, 'masked_ocr_text');
  assert.equal(f.c.state().observation_mode, 'masked_ocr_text');
  assert.ok(f.raw().every(value => value === 0)); await f.c.pause();
});

for (const [kind, code] of [['empty', 'post_mask_ocr_empty'], ['large', 'post_mask_ocr_too_large'],
  ['bytes', 'post_mask_ocr_too_large'], ['error', 'post_mask_ocr_failed'], ['mutated', 'post_mask_ocr_image_changed']]) {
  test(`post-mask OCR ${kind} fails visibly without posting, truncating, fallback or retaining pixels`, async () => {
    const f = fixture(); let pass = 0, finalImage;
    f.c.ocr.recognize = async buffer => {
      if (++pass % 2) return {text: 'PUBLIC', words: [{text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]};
      finalImage = buffer;
      if (kind === 'error') throw new Error('RAW_INTERNAL_SECRET');
      if (kind === 'mutated') buffer[buffer.length - 1] ^= 1;
      return {text: kind === 'empty' ? ' \n ' : kind === 'large' ? 'A'.repeat(2001) : kind === 'bytes' ? '😀'.repeat(1600) : 'SAFE', words: []};
    };
    await assert.rejects(f.c.previewMasked({...config, observation_mode: 'masked_ocr_text'}), new RegExp(code));
    assert.equal(f.c.preview, null); assert.equal(f.c.lastResult, code); assert.equal(f.calls.posts.length, 0);
    assert.ok(f.raw().every(value => value === 0)); assert.ok(finalImage.every(value => value === 0));
    assert.equal(pass, 2); await f.c.pause();
  });
}

test('pause during second OCR discards late text and pixels without recording or replacing pause reason', async () => {
  const f = fixture(), waiting = deferred(), ocrConfig = {...config, observation_mode: 'masked_ocr_text'};
  await f.c.previewMasked(ocrConfig); await f.c.start(ocrConfig);
  let pass = 0, finalImage, inspectionsAfterPause = 0;
  f.c.ocr.recognize = async buffer => {
    if (++pass === 1) return {text: 'PUBLIC', words: [{text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]};
    finalImage = buffer; return waiting.promise;
  };
  const capture = f.c.captureOnce(); await tick(); assert.equal(pass, 2);
  await f.c.pause('user_paused'); f.provider.inspect = async () => { inspectionsAfterPause++; throw new Error('helper_respawned'); };
  waiting.resolve({text: 'LATE SAFE TEXT', words: []});
  await capture; assert.equal(f.calls.posts.length, 0); assert.equal(f.c.active, false);
  assert.equal(f.c.lastResult, 'user_paused'); assert.ok(finalImage.every(value => value === 0));
  assert.equal(inspectionsAfterPause, 0);
});


test('cancelled preview second OCR never inspects or respawns helper after pause', async () => {
  const f = fixture(), waiting = deferred(); let pass = 0, finalImage, afterClose = 0;
  f.c.ocr.recognize = async buffer => {
    if (++pass === 1) return {text: 'PUBLIC', words: [{text: 'PUBLIC', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]};
    finalImage = buffer; return waiting.promise;
  };
  const preview = f.c.previewMasked({...config, observation_mode: 'masked_ocr_text'});
  await new Promise(resolve => setTimeout(resolve, 230)); assert.equal(pass, 2);
  await f.c.pause(); f.provider.inspect = async () => { afterClose++; throw new Error('helper_respawned'); };
  waiting.resolve({text: 'SAFE LATE TEXT', words: []});
  await assert.rejects(preview, /preview_cancelled/);
  assert.equal(afterClose, 0); assert.equal(f.c.preview, null); assert.ok(finalImage.every(value => value === 0));
});
