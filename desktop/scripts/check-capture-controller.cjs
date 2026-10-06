const assert = require('node:assert/strict');
const {test} = require('node:test');
const {PNG} = require('pngjs');
const {CaptureController, maskedPng, fingerprint} = require('../src/capture-controller.cjs');

function image() {
  const png = new PNG({width: 40, height: 20});
  png.data.fill(255);
  return PNG.sync.write(png);
}

function fixture() {
  const calls = {capture: 0, posts: 0, configure: 0};
  const controller = new CaptureController({
    captureScreen: async () => { calls.capture++; return image(); },
    foregroundApp: async () => 'editor.exe', windowNames: async () => ['Editor'],
    ocr: {recognize: async () => ({text: 'API KEY: sk-synthetic12345',
      words: [{text: 'sk-synthetic12345', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]})},
    postObservation: async body => { calls.posts++; assert.equal(body.local_ocr_complete, true);
      assert.equal(body.masks_applied, true); return {recorded: true}; },
    configureBackend: async () => { calls.configure++; },
    startBackendCapture: async () => {}, pauseBackendCapture: async () => {},
    clock: () => Date.parse('2026-09-23T00:00:00Z'),
  });
  return {controller, calls};
}
const config = {display_id: 'screen_1', excluded_apps: ['password-manager'], masks: []};

test('mask OCR secrets and user zones before any output', () => {
  const result = maskedPng(image(), {text: 'sk-synthetic12345',
    words: [{text: 'sk-synthetic12345', bbox: {x0: 1, y0: 1, x1: 20, y1: 10}}]},
    [{x: 30, y: 15, width: 5, height: 4}]);
  const decoded = PNG.sync.read(result.buffer);
  const pixel = (x, y) => decoded.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4);
  assert.deepEqual([...pixel(2, 2)], [0, 0, 0, 255]);
  assert.deepEqual([...pixel(31, 16)], [0, 0, 0, 255]);
  assert.deepEqual([...pixel(25, 18)], [255, 255, 255, 255]);
});

test('sensitive label also masks adjacent value words', () => {
  const result = maskedPng(image(), {text: 'Password 123456', words: [
    {text: 'Password', bbox: {x0: 1, y0: 1, x1: 12, y1: 10}},
    {text: '123456', bbox: {x0: 20, y0: 1, x1: 34, y1: 10}},
  ]}, []);
  const decoded = PNG.sync.read(result.buffer);
  const valuePixel = (3 * 40 + 25) * 4;
  assert.deepEqual([...decoded.data.subarray(valuePixel, valuePixel + 4)], [0, 0, 0, 255]);
});

// The historical full-screen path is unavailable even with apparently valid or
// stale authorization. These tests deliberately install hostile saved state and
// providers; no provider, OCR, backend mutation, or timer may be reached.
for (const method of ['previewMasked', 'start', 'process', 'captureOnce']) {
  test(`full desktop ${method} rejects before any provider or backend call`, async () => {
    for (const input of [undefined, config, {...config, capture_scope: 'full_screen'},
      {...config, full_desktop: {supported: true}, confirmed: true}]) {
      const {controller, calls} = fixture();
      const forbidden = () => { throw new Error('unavailable path reached a dependency'); };
      controller.foregroundApp = forbidden;
      controller.windowNames = forbidden;
      controller.ocr.recognize = forbidden;
      controller.configureBackend = forbidden;
      controller.startBackendCapture = forbidden;
      controller.postObservation = forbidden;
      controller.active = true;
      controller.config = config;
      controller.preview = {fingerprint: fingerprint(config), when: controller.clock()};
      await assert.rejects(controller[method](input), /^Error: full_desktop_unavailable$/);
      assert.deepEqual(calls, {capture: 0, posts: 0, configure: 0});
      assert.equal(controller.timer, null);
    }
  });
}

test('cancel, lock, suspend and repeated resume never reopen full desktop', async () => {
  for (const reason of ['paused', 'lock-screen', 'suspend', 'shutdown']) {
    const {controller, calls} = fixture();
    let pauses = 0;
    controller.pauseBackendCapture = async () => { pauses++; };
    controller.active = true;
    controller.config = config;
    controller.preview = {fingerprint: fingerprint(config), when: controller.clock()};
    const generation = controller.generation;
    await controller.pause(reason);
    assert.equal(controller.active, false);
    assert.equal(controller.preview, null);
    assert.equal(controller.config, null);
    assert.equal(controller.timer, null);
    assert.ok(controller.generation > generation);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(controller.previewMasked(config), /full_desktop_unavailable/);
      await assert.rejects(controller.start(config), /full_desktop_unavailable/);
      await assert.rejects(controller.captureOnce(), /full_desktop_unavailable/);
    }
    assert.equal(pauses, 1);
    assert.deepEqual(calls, {capture: 0, posts: 0, configure: 0});
  }
});

test('a mocked late processing result cannot be reached through full-screen preview', async () => {
  const {controller} = fixture();
  let calls = 0;
  controller.process = async () => { calls++; return {ok: true, buffer: image(), maskedRegions: 0}; };
  await assert.rejects(controller.previewMasked(config), /full_desktop_unavailable/);
  await controller.pause();
  await assert.rejects(controller.previewMasked(config), /full_desktop_unavailable/);
  assert.equal(calls, 0);
  assert.equal(controller.preview, null);
});
