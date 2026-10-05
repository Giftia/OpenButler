'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {PNG} = require('pngjs');
const {PublicWindowProvider, checkedIdentity} = require('./public-window-provider.cjs');

function bmpToPng(raw, identity) {
  try {
    const {width, height} = checkedIdentity(identity).content_bounds;
    if (!Buffer.isBuffer(raw) || raw.length < 54 || raw.toString('ascii', 0, 2) !== 'BM'
      || raw.readUInt32LE(10) !== 54 || raw.readUInt32LE(14) !== 40
      || raw.readInt32LE(18) !== width || raw.readInt32LE(22) !== -height
      || raw.readUInt16LE(26) !== 1 || raw.readUInt16LE(28) !== 32
      || raw.readUInt32LE(30) !== 0 || raw.length !== 54 + width * height * 4
      || raw.readUInt32LE(2) !== raw.length) throw new Error('invalid_source_frame');
    const png = new PNG({width, height});
    let nonblack = false;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = 54 + pixel * 4;
      png.data[pixel * 4] = raw[offset + 2]; png.data[pixel * 4 + 1] = raw[offset + 1];
      png.data[pixel * 4 + 2] = raw[offset]; png.data[pixel * 4 + 3] = 255;
      if (raw[offset] > 20 || raw[offset + 1] > 20 || raw[offset + 2] > 20) nonblack = true;
    }
    try { return {buffer: PNG.sync.write(png), content_nonblack: nonblack}; }
    finally { png.data.fill(0); }
  } finally { if (Buffer.isBuffer(raw)) raw.fill(0); }
}

class WindowsPublicWindowProvider extends PublicWindowProvider {
  constructor({helperPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'windows-public-window.exe'),
    spawnProcess = spawn} = {}) {
    super({spawnProcess}); this.helperPath = helperPath;
    this.platform = 'windows-hwnd-wgc'; this.captureMethod = 'windows_wgc_hwnd';
    this.lockState = 'unlocked'; this.lockProtectionSupported = true;
  }
  available() { return process.platform === 'win32' && fs.existsSync(this.helperPath); }
  ensure() {
    if (this.child) return;
    if (!this.available()) throw new Error('public_window_platform_unsupported');
    const child = this.spawnProcess(this.helperPath, ['--provider'], {stdio: ['pipe','pipe','ignore'], windowsHide: true});
    this.child = child;
    child.stdout.on('data', chunk => { if (this.child === child) this.receive(chunk); else chunk.fill(0); });
    child.on('error', () => { if (this.child === child) this.close(); });
    child.on('exit', () => { if (this.child === child) { this.child = null; ++this.generation; this.fail('window_source_unavailable'); } });
  }
  async probe() { return this.available() && (await this.request({action:'probe'})).supported === true; }
  bind(identity) {
    const checked = checkedIdentity(identity);
    if (!checked.window_id.startsWith('hwnd:')) throw new Error('source_platform_mismatch');
    return super.bind(checked);
  }
  async acquireFrame() {
    const frame = await super.acquireFrame();
    if (frame.pixel_encoding !== 'bmp-bgra32' || frame.capture_method !== this.captureMethod) {
      frame.buffer?.fill(0); throw new Error('invalid_source_frame');
    }
    return {...frame, ...bmpToPng(frame.buffer, frame.source_identity)};
  }
}
module.exports = {WindowsPublicWindowProvider, bmpToPng};
