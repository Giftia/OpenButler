'use strict';

const {spawn} = require('node:child_process');
const path = require('node:path');
const {createHash} = require('node:crypto');
const FORMAT_KEYS = ['depth', 'bits_per_pixel', 'byte_order', 'format', 'xoffset', 'bytes_per_line',
  'red_mask', 'green_mask', 'blue_mask', 'visual_visual_id', 'visual_visual_class',
  'visual_red_mask', 'visual_green_mask', 'visual_blue_mask', 'visual_depth'];

function checkedIdentity(value) {
  if (!value || !/^(?:x11:[1-9][0-9]{0,10}|hwnd:[1-9][0-9]{0,19})$/.test(value.window_id)
    || !Number.isSafeInteger(value.owner_pid) || value.owner_pid < 1
    || !/^[0-9]{1,30}$/.test(value.owner_process_start)
    || !['owner_process_name', 'wm_class', 'window_title'].every(key =>
      typeof value[key] === 'string' && value[key].length > 0
      && value[key].length <= (key === 'owner_process_name' ? 120 : 240)
      && !/[\x00-\x1f\x7f]/.test(value[key]))
    || !value.content_bounds || !['x', 'y', 'width', 'height'].every(key =>
      Number.isSafeInteger(value.content_bounds[key]) && value.content_bounds[key] >= 0)
    || !value.content_bounds.width || !value.content_bounds.height
    || value.content_bounds.width > 16000 || value.content_bounds.height > 16000
    || value.content_bounds.width * value.content_bounds.height > 16_000_000) {
    throw new Error('invalid_window_identity');
  }
  return {window_id: value.window_id, owner_pid: value.owner_pid,
    owner_process_start: value.owner_process_start, owner_process_name: value.owner_process_name,
    wm_class: value.wm_class, window_title: value.window_title,
    content_bounds: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, value.content_bounds[key]]))};
}

function sourceRevision(identity) {
  return createHash('sha256').update(JSON.stringify(checkedIdentity(identity))).digest('hex');
}

class PublicWindowProvider {
  constructor({python = process.env.OPENBUTLER_PYTHON || 'python3', spawnProcess = spawn} = {}) {
    this.python = python;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.pending = null;
    this.bytes = Buffer.alloc(0);
    this.header = null;
    this.queue = Promise.resolve();
    this.generation = 0;
    this.lastFormatKey = null;
  }

  available() { return process.platform === 'linux' && Boolean(process.env.DISPLAY)
    && process.env.XDG_SESSION_TYPE !== 'wayland'; }

  ensure() {
    if (this.child) return;
    if (!this.available()) throw new Error('public_window_platform_unsupported');
    const child = this.spawnProcess(this.python, ['-u', path.join(__dirname, 'x11-public-window.py')],
      {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
    this.child = child;
    child.stdout.on('data', chunk => { if (this.child === child) this.receive(chunk); else chunk.fill(0); });
    child.on('error', () => { if (this.child === child) this.close(); });
    child.on('exit', () => {
      if (this.child === child) { this.child = null; ++this.generation; this.fail('window_source_unavailable'); }
    });
  }

  fail(reason) {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.bytes.fill(0);
    this.bytes = Buffer.alloc(0);
    this.header = null;
  }

  receive(chunk) {
    if (!this.pending || this.bytes.length + chunk.length > 9 * 1024 * 1024) {
      chunk.fill(0); this.close(); return;
    }
    const old = this.bytes;
    this.bytes = Buffer.concat([old, chunk]);
    old.fill(0); chunk.fill(0);
    try {
      if (!this.header) {
        const end = this.bytes.indexOf(10);
        if (end < 0) return;
        if (end > 100_000) throw new Error('source_protocol_failed');
        this.header = JSON.parse(this.bytes.subarray(0, end).toString('utf8'));
        const next = Buffer.from(this.bytes.subarray(end + 1));
        this.bytes.fill(0); this.bytes = next;
      }
      const length = this.header.raw_bytes || 0;
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
        throw new Error('source_protocol_failed');
      }
      if (this.bytes.length < length) return;
      if (this.bytes.length !== length) throw new Error('source_protocol_failed');
      const pending = this.pending;
      this.pending = null; clearTimeout(pending.timer);
      const result = this.header;
      this.header = null;
      if (result.format_metadata && FORMAT_KEYS.every(key =>
        Number.isSafeInteger(result.format_metadata[key])
        && result.format_metadata[key] >= -0x80000000 && result.format_metadata[key] <= 0xffffffff)) {
        const fixed = JSON.stringify(Object.fromEntries(FORMAT_KEYS.map(key => [key, result.format_metadata[key]])));
        if (process.env.OPENBUTLER_STARTUP_DIAGNOSTICS === '1' && fixed !== this.lastFormatKey) {
          // A fixed numerical header only, never image bytes or source text.
          console.warn('OpenButler source pixel format ' + fixed);
        }
        this.lastFormatKey = fixed;
      }
      if (length) result.buffer = this.bytes;
      this.bytes = Buffer.alloc(0);
      if (result.ok !== true) pending.reject(new Error(result.error || 'window_source_unavailable'));
      else pending.resolve(result);
    } catch { this.close(); }
  }

  request(command) {
    const generation = this.generation;
    const job = this.queue.then(() => new Promise((resolve, reject) => {
      if (generation !== this.generation) throw new Error('window_source_cancelled');
      this.ensure();
      const timer = setTimeout(() => this.close(), 8_000);
      this.pending = {resolve, reject, timer};
      this.child.stdin.write(JSON.stringify(command) + '\n');
    }));
    this.queue = job.catch(() => {});
    return job;
  }

  async listSources() {
    const result = await this.request({action: 'list'});
    return result.sources.map(checkedIdentity).map(identity => ({id: identity.window_id,
      label: identity.window_title, source_identity: identity}));
  }
  bind(identity) { return this.request({action: 'bind', source_identity: checkedIdentity(identity)}); }
  prepareSource() { return this.request({action: 'prepare'}); }
  inspect() { return this.request({action: 'inspect'}); }
  acquireFrame() { return this.request({action: 'capture'}); }
  close() {
    ++this.generation;
    const child = this.child;
    this.child = null;
    this.fail('window_source_unavailable');
    if (child) child.kill();
  }
}

module.exports = {PublicWindowProvider, checkedIdentity, sourceRevision};
