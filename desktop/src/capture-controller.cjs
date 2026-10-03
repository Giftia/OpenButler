const {createHash} = require('node:crypto');
const {PNG} = require('pngjs');

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_PREVIEW_AGE_MS = 5 * 60_000;
const sensitivePattern = /(?:\b(?:password|passcode|secret|token|api\s*key|bearer|authorization)\b|密码|密钥|验证码|(?:\b\d[ -]?){12,19}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\bsk-[A-Za-z0-9_-]{8,})/i;

function validConfig(config) {
  if (!config || typeof config !== 'object' || !/^[a-zA-Z0-9:_.-]{1,80}$/.test(config.display_id)
      || !Array.isArray(config.excluded_apps) || config.excluded_apps.length < 1
      || config.excluded_apps.some(name => typeof name !== 'string' || name.length < 1 || name.length > 120)
      || !Array.isArray(config.masks)) throw new Error('invalid_capture_configuration');
  for (const rect of config.masks) {
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key]))
        || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) {
      throw new Error('invalid_capture_mask');
    }
  }
  return {
    display_id: config.display_id,
    excluded_apps: [...config.excluded_apps],
    masks: config.masks.map(({x, y, width, height}) => ({x, y, width, height})),
  };
}

function fingerprint(config) {
  return createHash('sha256').update(JSON.stringify(validConfig(config))).digest('hex');
}

function paintRect(png, {x, y, width, height}) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(png.width, Math.ceil(x + width));
  const bottom = Math.min(png.height, Math.ceil(y + height));
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      const pixel = (row * png.width + column) * 4;
      png.data[pixel] = 0;
      png.data[pixel + 1] = 0;
      png.data[pixel + 2] = 0;
      png.data[pixel + 3] = 255;
    }
  }
}

function maskedPng(raw, ocr, fixedMasks) {
  if (!Buffer.isBuffer(raw) || raw.length > 8 * 1024 * 1024
      || !ocr || typeof ocr.text !== 'string' || !Array.isArray(ocr.words)) {
    throw new Error('local_redaction_unavailable');
  }
  const png = PNG.sync.read(raw);
  if (!png.width || !png.height || png.width * png.height > 16_000_000) {
    throw new Error('local_redaction_unavailable');
  }
  const words = ocr.words;
  if (ocr.text.trim() && words.length === 0) throw new Error('local_redaction_unavailable');
  const sensitiveTextFound = sensitivePattern.test(ocr.text);
  // A label and its value can be separate OCR words; redact all recognized text when sensitive.
  const maskWords = sensitiveTextFound ? words : [];
  if (maskWords.some(word => !word.bbox || !['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(word.bbox[key])))) {
    throw new Error('local_redaction_unavailable');
  }
  for (const rect of fixedMasks) paintRect(png, rect);
  for (const word of maskWords) {
    const {x0, y0, x1, y1} = word.bbox;
    paintRect(png, {x: x0 - 5, y: y0 - 5, width: x1 - x0 + 10, height: y1 - y0 + 10});
  }
  try {
    return {buffer: PNG.sync.write(png), maskedRegions: fixedMasks.length + maskWords.length};
  } finally { png.data.fill(0); }
}

class CaptureController {
  constructor({captureScreen, foregroundApp, windowNames, ocr, postObservation,
    configureBackend, startBackendCapture, pauseBackendCapture, clock = () => Date.now(),
    intervalMs = DEFAULT_INTERVAL_MS}) {
    Object.assign(this, {captureScreen, foregroundApp, windowNames, ocr, postObservation,
      configureBackend, startBackendCapture, pauseBackendCapture, clock, intervalMs});
    this.config = null;
    this.preview = null;
    this.timer = null;
    this.active = false;
    this.busy = false;
    this.lastResult = 'idle';
    this.generation = 0; this.starting = false;
  }

  async eligible(config) {
    const foreground = await this.foregroundApp();
    if (!foreground || typeof foreground !== 'string') return false;
    const normalized = foreground.toLowerCase();
    if (config.excluded_apps.some(name => normalized.includes(name.toLowerCase()))) return false;
    const windows = await this.windowNames(config.display_id);
    if (!Array.isArray(windows)) return false;
    return !windows.some(title => config.excluded_apps.some(name =>
      typeof title === 'string' && title.toLowerCase().includes(name.toLowerCase())));
  }

  async process(config, current = () => {}) {
    current();
    if (!await this.eligible(config)) return {ok: false, reason: 'application_excluded_or_unknown'};
    current();
    const raw = await this.captureScreen(config.display_id);
    if (!Buffer.isBuffer(raw)) throw new Error('screen_capture_unavailable');
    try {
      current();
      const detected = await this.ocr.recognize(raw);
      current();
      const masked = maskedPng(raw, detected, config.masks);
      return {ok: true, buffer: masked.buffer, maskedRegions: masked.maskedRegions};
    } finally {
      raw.fill(0);
    }
  }

  async previewMasked(configInput) {
    const config = validConfig(configInput);
    const generation = this.generation;
    const processed = await this.process(config, () => {
      if (generation !== this.generation) throw new Error('preview_cancelled');
    });
    if (!processed.ok) return processed;
    if (generation !== this.generation) { processed.buffer.fill(0); throw new Error('preview_cancelled'); }
    this.preview = {fingerprint: fingerprint(config), when: this.clock()};
    return {ok: true, previewDataUrl: `data:image/png;base64,${processed.buffer.toString('base64')}`,
      maskedRegions: processed.maskedRegions};
  }

  async start(configInput) {
    const config = validConfig(configInput);
    if (!this.preview || this.preview.fingerprint !== fingerprint(config)
        || this.clock() - this.preview.when > MAX_PREVIEW_AGE_MS) {
      throw new Error('privacy_preview_required');
    }
    if (this.active || this.starting) throw new Error('capture_already_active');
    const generation = ++this.generation;
    const current = () => { if (generation !== this.generation) throw new Error('capture_cancelled'); };
    this.starting = true; this.preview = null;
    try {
      await this.configureBackend({...config, confirmed: true});
      current();
      await this.startBackendCapture();
      current();
    } catch (error) {
      if (generation !== this.generation) {
        await this.pauseBackendCapture({reason: captureStopReason(this.lastResult)}).catch(() => {});
      }
      throw error;
    } finally { this.starting = false; }
    this.config = config;
    this.active = true;
    this.lastResult = 'recording';
    this.timer = setInterval(() => {
      void this.captureOnce().catch(async () => {
        if (generation !== this.generation) return;
        try {
          await this.pause('privacy_processing_failed');
        } catch {
          this.lastResult = 'privacy_processing_failed';
        }
      });
    }, this.intervalMs);
    return this.state();
  }

  async captureOnce() {
    if (!this.active || !this.config || this.busy) return {recorded: false};
    this.busy = true;
    const generation = this.generation;
    try {
      const processed = await this.process(this.config, () => {
        if (!this.active || generation !== this.generation) throw new Error('capture_cancelled');
      });
      if (!this.active || generation !== this.generation) return {recorded: false, reason: 'paused'};
      if (!processed.ok) {
        this.lastResult = processed.reason;
        return {recorded: false, reason: processed.reason};
      }
      if (!this.active) return {recorded: false, reason: 'paused'};
      const result = await this.postObservation({
        display_id: this.config.display_id,
        captured_at: new Date(this.clock()).toISOString(),
        masked_png_base64: processed.buffer.toString('base64'),
        local_ocr_complete: true,
        masks_applied: true,
      });
      if (!this.active || generation !== this.generation) return {recorded: false, reason: 'paused'};
      this.lastResult = result.recorded ? 'recorded' : 'unchanged';
      return result;
    } finally {
      this.busy = false;
    }
  }

  async pause(reason = 'paused') {
    this.active = false; ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.config = null;
    this.preview = null;
    this.lastResult = reason;
    await this.pauseBackendCapture({reason: captureStopReason(reason)});
    return this.state();
  }

  state() {
    return {active: this.active, intervalSeconds: this.intervalMs / 1000,
      lastResult: this.lastResult};
  }
}

// Persist only bounded control reasons, never native error text or window names.
function captureStopReason(reason) {
  if (['paused', 'user_paused'].includes(reason)) return 'user_paused';
  if (reason === 'session_expired') return 'session_expired';
  if (['shutdown', 'before-quit', 'service_restarted'].includes(reason)) return 'shutdown';
  if (reason === 'model_reconfigured') return 'configuration_changed';
  if (typeof reason === 'string' && /^(?:source_|window_|application_|invalid_public_window_capabilities|lock-screen|suspend|renderer_unavailable)/.test(reason)) {
    return 'source_unavailable';
  }
  return 'capture_error';
}

module.exports = {CaptureController, maskedPng, validConfig, fingerprint, captureStopReason};
