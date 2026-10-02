'use strict';

const {randomUUID, createHash} = require('node:crypto');
const {maskedPng, validConfig} = require('./capture-controller.cjs');
const {checkedIdentity, sourceRevision} = require('./public-window-provider.cjs');
const SCOPE = 'dedicated_public_window';
const METHOD = 'xcomposite_named_window_pixmap';

function publicConfig(input) {
  if (input?.capture_scope !== SCOPE) throw new Error('invalid_public_window_scope');
  const base = validConfig(input);
  const identity = checkedIdentity(input.source_identity);
  if (base.display_id !== identity.window_id) throw new Error('source_binding_mismatch');
  const duration = input.session_duration_seconds ?? 600;
  const interval = input.interval_seconds ?? 10;
  const observationMode = input.observation_mode ?? 'vision';
  if (!['vision', 'masked_ocr_text'].includes(observationMode)) throw new Error('invalid_observation_mode');
  if (!Number.isSafeInteger(duration) || duration < 30 || duration > 3600) {
    throw new Error('invalid_session_duration');
  }
  if (![10, 30, 60].includes(interval)) throw new Error('invalid_capture_interval');
  for (const mask of base.masks) {
    if (mask.x + mask.width > identity.content_bounds.width
      || mask.y + mask.height > identity.content_bounds.height) throw new Error('invalid_capture_mask');
  }
  return {...base, capture_scope: SCOPE, source_identity: identity,
    session_duration_seconds: duration, interval_seconds: interval, observation_mode: observationMode};
}
const fingerprint = config => createHash('sha256').update(JSON.stringify(publicConfig(config))).digest('hex');

class PublicWindowController {
  constructor({provider, ocr, configureBackend, startBackendCapture, pauseBackendCapture,
    postObservation, clock = () => Date.now(), intervalMs = 10_000}) {
    Object.assign(this, {provider, ocr, configureBackend, startBackendCapture, pauseBackendCapture,
      postObservation, clock, intervalMs});
    this.active = false; this.preview = null; this.config = null; this.busy = false;
    this.lastResult = 'idle'; this.generation = 0; this.sequence = 0;
  }

  async inspect(config) {
    const inspection = await this.provider.inspect();
    if (sourceRevision(inspection.source_identity) !== sourceRevision(config.source_identity)) {
      throw new Error('source_binding_mismatch');
    }
    const foreground = checkedIdentity(inspection.foreground_identity);
    const app = `${foreground.owner_process_name} ${foreground.wm_class} ${foreground.window_title}`.toLowerCase();
    const selected = `${config.source_identity.owner_process_name} ${config.source_identity.wm_class} ${config.source_identity.window_title}`.toLowerCase();
    if (config.excluded_apps.some(name => app.includes(name.toLowerCase()) || selected.includes(name.toLowerCase()))) {
      throw new Error('application_excluded_or_unknown');
    }
    if (inspection.lock_state !== 'unknown' || inspection.lock_protection_supported !== false) {
      throw new Error('invalid_public_window_capabilities');
    }
    return inspection;
  }

  async process(config, current) {
    current();
    await this.inspect(config);
    current();
    const frame = await this.provider.acquireFrame();
    try {
      current();
      if (!Buffer.isBuffer(frame.buffer) || frame.capture_method !== METHOD
        || frame.source_verified_before !== true || frame.source_verified_after !== true
        || sourceRevision(frame.source_identity) !== sourceRevision(config.source_identity)
        || !Number.isSafeInteger(frame.captured_at_ms) || this.clock() - frame.captured_at_ms > 8_000
        || frame.captured_at_ms > this.clock()) throw new Error('invalid_source_frame');
      if (frame.content_nonblack !== true) throw new Error('window_repaint_incomplete');
      const detected = await this.ocr.recognize(frame.buffer);
      current();
      if (!detected.text?.trim()) throw new Error('window_repaint_or_text_unavailable');
      const masked = maskedPng(frame.buffer, detected, config.masks);
      frame.buffer.fill(0);
      // Raw OCR text never crosses the local redactor boundary.
      try {
        let postMaskOcr = {};
        if (config.observation_mode === 'masked_ocr_text') {
          const digest = createHash('sha256').update(masked.buffer).digest('hex');
          let result;
          try { result = await this.ocr.recognize(masked.buffer); }
          catch { throw new Error('post_mask_ocr_failed'); }
          current();
          if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('post_mask_ocr_empty');
          if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.text)) {
            throw new Error('post_mask_ocr_invalid');
          }
          if (Array.from(result.text).length > 2000 || Buffer.byteLength(result.text, 'utf8') > 6000) {
            throw new Error('post_mask_ocr_too_large');
          }
          if (createHash('sha256').update(masked.buffer).digest('hex') !== digest) {
            throw new Error('post_mask_ocr_image_changed');
          }
          postMaskOcr = {post_mask_ocr_complete: true, post_mask_ocr_engine: 'tesseract.js', post_mask_ocr_text: result.text,
            post_mask_ocr_image_digest: digest};
        }
        current();
        await this.inspect(config);
        current();
        return {...masked, postMaskOcr, capturedAt: frame.captured_at_ms};
      } catch (error) { masked.buffer.fill(0); throw error; }
    } finally { if (Buffer.isBuffer(frame.buffer)) frame.buffer.fill(0); }
  }

  async previewMasked(input) {
    if (this.active || this.busy) throw new Error('capture_already_active');
    this.preview = null;
    const config = publicConfig(input);
    const generation = ++this.generation;
    this.busy = true;
    clearTimeout(this.previewExpiryTimer);
    this.previewExpiryTimer = setTimeout(() => {
      if (!this.active && generation === this.generation) {
        this.preview = null; ++this.generation; this.provider.close();
        this.lastResult = 'privacy_preview_expired';
      }
    }, 300_000);
    try {
      await this.provider.bind(config.source_identity);
      if (generation !== this.generation) throw new Error('preview_cancelled');
      await this.inspect(config);
      await this.provider.prepareSource();
      if (generation !== this.generation) throw new Error('preview_cancelled');
      // Give the selected app a scheduling opportunity, but never infer complete
      // repaint from elapsed time: black/textless frames still fail closed.
      await new Promise(resolve => setTimeout(resolve, 200));
      if (generation !== this.generation) throw new Error('preview_cancelled');
      const processed = await this.process(config, () => {
        if (generation !== this.generation) throw new Error('preview_cancelled');
      });
      try {
        if (generation !== this.generation) throw new Error('preview_cancelled');
        this.preview = {fingerprint: fingerprint(config), when: this.clock()};
        return {ok: true, capture_scope: SCOPE,
          observation_mode: config.observation_mode, ...processed.postMaskOcr,
          previewDataUrl: `data:image/png;base64,${processed.buffer.toString('base64')}`,
          maskedRegions: processed.maskedRegions, source_revision: sourceRevision(config.source_identity),
          lock_state: 'unknown', lock_protection_supported: false};
      } finally { processed.buffer.fill(0); }
    } catch (error) {
      if (generation === this.generation) {
        clearTimeout(this.previewExpiryTimer); this.previewExpiryTimer = null;
        this.preview = null; this.provider.close(); this.lastResult = error.message || 'privacy_processing_failed';
      }
      throw error;
    } finally { this.busy = false; }
  }

  async start(input) {
    const config = publicConfig(input);
    if (this.active || this.busy) throw new Error('capture_already_active');
    if (!this.preview || this.preview.fingerprint !== fingerprint(config)
      || this.clock() - this.preview.when > 300_000) throw new Error('privacy_preview_required');
    const generation = ++this.generation;
    const current = () => {
      if (generation !== this.generation) throw new Error('capture_cancelled');
    };
    this.busy = true;
    this.preview = null; // Consume the one-time preview before any asynchronous work.
    clearTimeout(this.previewExpiryTimer); this.previewExpiryTimer = null;
    try {
      await this.inspect(config);
      current();
      this.intervalMs = config.interval_seconds * 1000;
      const session = {capture_scope: SCOPE, source_kind: 'public_window',
      observation_mode: config.observation_mode,
      session_id: randomUUID(), source_revision: sourceRevision(config.source_identity),
      source_identity: config.source_identity, lock_state: 'unknown', lock_protection_supported: false,
      capture_method: METHOD, sampling_interval_ms: this.intervalMs,
      session_expires_at: new Date(this.clock() + config.session_duration_seconds * 1000).toISOString()};
      const configured = await this.configureBackend({display_id: config.display_id,
      excluded_apps: config.excluded_apps, masks: config.masks, confirmed: true, ...session});
      current();
      if (!/^[0-9a-f-]{36}$/.test(configured?.consent_revision || '')) throw new Error('source_consent_unavailable');
      await this.startBackendCapture();
      current();
      await this.inspect(config);
      current();
      this.config = config; this.session = {...session, consent_revision: configured.consent_revision};
      this.active = true; this.sequence = 0; this.lastCaptureAt = null;
      this.lastResult = 'recording';
      this.timer = setInterval(() => { void this.captureOnce(); }, this.intervalMs);
      this.guardTimer = setInterval(() => {
        if (this.active && generation === this.generation) void this.inspect(this.config).catch(error => {
          if (generation === this.generation) return this.pause(error.message).catch(() => {});
        });
      }, 1000);
      this.expiryTimer = setTimeout(() => { void this.pause('session_expired').catch(() => {}); },
        config.session_duration_seconds * 1000);
      this.firstTimer = setTimeout(() => { void this.captureOnce(); }, 250);
      return this.state();
    } catch (error) {
      await this.pause(error.message || 'privacy_processing_failed').catch(() => {});
      throw error;
    } finally { this.busy = false; }
  }

  async captureOnce() {
    if (!this.active || this.busy) return {recorded: false};
    this.busy = true;
    const generation = this.generation;
    let processed;
    try {
      if (this.clock() >= Date.parse(this.session.session_expires_at)) throw new Error('session_expired');
      processed = await this.process(this.config, () => {
        if (!this.active || generation !== this.generation) throw new Error('capture_cancelled');
      });
      if (!this.active || generation !== this.generation) return {recorded: false, reason: 'paused'};
      await this.inspect(this.config);
      if (!this.active || generation !== this.generation) return {recorded: false, reason: 'paused'};
      const result = await this.postObservation({display_id: this.config.display_id, ...this.session,
        ...processed.postMaskOcr,
        captured_at: new Date(processed.capturedAt).toISOString(),
        masked_png_base64: processed.buffer.toString('base64'), local_ocr_complete: true, masks_applied: true,
        source_verified_before: true, source_verified_after: true, sampling_sequence: ++this.sequence,
        sampling_gap_ms: this.lastCaptureAt === null ? 0 : Math.max(0,
          processed.capturedAt - this.lastCaptureAt - this.intervalMs)});
      if (!this.active || generation !== this.generation) return {recorded: false, reason: 'paused'};
      this.lastCaptureAt = processed.capturedAt;
      this.lastResult = result.recorded ? 'recorded' : 'unchanged';
      return result;
    } catch (error) {
      if (generation === this.generation) await this.pause(error.message || 'privacy_processing_failed').catch(() => {});
      return {recorded: false, reason: this.lastResult};
    } finally { processed?.buffer.fill(0); this.busy = false; }
  }

  async pause(reason = 'paused') {
    this.active = false; ++this.generation;
    for (const key of ['timer', 'guardTimer', 'expiryTimer', 'firstTimer', 'previewExpiryTimer']) {
      clearTimeout(this[key]); this[key] = null;
    }
    this.preview = null; this.config = null; this.session = null;
    this.lastResult = reason;
    this.provider.close();
    await this.pauseBackendCapture();
    return this.state();
  }

  state() {
    return {active: this.active, intervalSeconds: this.intervalMs / 1000, lastResult: this.lastResult,
      observation_mode: this.config?.observation_mode || null,
      capture_scope: SCOPE, sessionExpiresAt: this.session?.session_expires_at || null,
      sourceIdentity: this.config?.source_identity || null, lock_state: 'unknown',
      lock_protection_supported: false};
  }
}

module.exports = {PublicWindowController, publicConfig, SCOPE, METHOD};
