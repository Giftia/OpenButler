const assert = require('node:assert/strict');
const {test} = require('node:test');
const {PNG} = require('pngjs');
const {CaptureController, maskedPng} = require('../src/capture-controller.cjs');

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

test('preview is explicit and binds exact start configuration', async () => {
  const {controller, calls} = fixture();
  await assert.rejects(controller.start(config), /privacy_preview_required/);
  assert.equal(calls.capture, 0);
  const preview = await controller.previewMasked(config);
  assert.match(preview.previewDataUrl, /^data:image\/png;base64,/);
  await assert.rejects(controller.start({...config, masks: [{x: 1, y: 1, width: 1, height: 1}]}),
    /privacy_preview_required/);
  await controller.start(config);
  assert.equal(calls.configure, 1);
  assert.equal(calls.posts, 0);
  assert.equal((await controller.captureOnce()).recorded, true);
  await controller.pause();
  await controller.captureOnce();
  assert.equal(calls.posts, 1);
});

test('excluded or unknown foreground prevents screenshot acquisition', async () => {
  const {controller, calls} = fixture();
  controller.foregroundApp = async () => 'password-manager.exe';
  assert.equal((await controller.previewMasked(config)).reason, 'application_excluded_or_unknown');
  controller.foregroundApp = async () => '';
  assert.equal((await controller.previewMasked(config)).reason, 'application_excluded_or_unknown');
  controller.foregroundApp = async () => 'editor.exe';
  controller.windowNames = async () => ['password-manager Settings'];
  assert.equal((await controller.previewMasked(config)).reason, 'application_excluded_or_unknown');
  assert.equal(calls.capture, 0);
});

test('OCR failure retains no preview or observation', async () => {
  const {controller, calls} = fixture();
  controller.ocr.recognize = async () => { throw new Error('offline_ocr_unavailable'); };
  await assert.rejects(controller.previewMasked(config), /offline_ocr_unavailable/);
  assert.equal(calls.posts, 0);
  await assert.rejects(controller.start(config), /privacy_preview_required/);
});

test('OCR failure during recording pauses instead of reporting active capture', async () => {
  const {controller, calls} = fixture();
  await controller.previewMasked(config);
  let pauseCalls = 0;
  controller.pauseBackendCapture = async () => { pauseCalls++; };
  controller.intervalMs = 5;
  controller.ocr.recognize = async () => { throw new Error('offline_ocr_unavailable'); };
  await controller.start(config);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(controller.state().active, false);
  assert.equal(controller.state().lastResult, 'privacy_processing_failed');
  assert.equal(pauseCalls, 1);
  assert.equal(calls.posts, 0);
});
