'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// This is the Electron process's resource namespace, NOT the selected Ollama
// server's hardware. Loopback, WSL forwarding, containers and tunnels cannot
// establish that they are the same device. No serial numbers, paths or hostnames
// leave this module. Called only by an explicit inspection IPC.
function readSmall(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65537);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 65536) throw new Error('resource_metadata_too_large');
    return buffer.toString('utf8', 0, length).trim();
  } finally { fs.closeSync(fd); }
}
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const number = text => /^\d+$/.test(text || '') ? positive(Number(text)) : null;
function hostInfo({platform = process.platform, arch = process.arch, read = readSmall,
  totalmem = os.totalmem, freemem = os.freemem,
  parallelism = () => os.availableParallelism?.() || os.cpus().length} = {}) {
  const result = {platform, arch, scope: 'desktop_process', memoryBytes: null,
    availableMemoryBytes: null, memorySource: 'unknown', cpuCount: null, gpu: 'unknown'};
  try { result.cpuCount = positive(parallelism()); } catch {}
  let physical, available;
  try { physical = positive(totalmem()); available = positive(freemem()); } catch {}
  if (platform !== 'linux') {
    result.memoryBytes = physical || null;
    result.availableMemoryBytes = available && physical ? Math.min(available, physical) : null;
    result.memorySource = physical ? 'physical' : 'unknown';
    return result;
  }
  try {
    const groups = read('/proc/self/cgroup').split('\n');
    const mounts = read('/proc/self/mountinfo').split('\n');
    const v2 = groups.find(line => line.startsWith('0::'));
    const v1 = groups.find(line => line.split(':')[1]?.split(',').includes('memory'));
    const group = v2 ? v2.slice(3) : v1?.split(':')[2];
    const mount = mounts.map(line => line.split(' ')).find(parts => {
      const split = parts.indexOf('-');
      return split > 0 && (v2 ? parts[split + 1] === 'cgroup2'
        : parts[split + 1] === 'cgroup' && parts.slice(split + 2).some(p => p.split(',').includes('memory')));
    });
    if (!group || !mount) return result;
    // Kernel paths with escaped whitespace or parent traversal are not guessed.
    // Keep the report unknown rather than accidentally reporting the host's RAM.
    const [root, mountPoint] = [mount[3], mount[4]];
    if (![group, root, mountPoint].every(p => p.startsWith('/') && !/[\\\s\0]/.test(p)
      && !p.split('/').includes('..'))) return result;
    const relative = root === '/' ? group.slice(1) : group === root ? ''
      : group.startsWith(root + '/') ? group.slice(root.length + 1) : null;
    if (relative === null || !mountPoint.startsWith('/sys/fs/cgroup')) return result;
    let current = path.posix.join(mountPoint, relative), limit = physical, free = available;
    let readAny = false, limited = false;
    // Inherited limits count: inspect each ancestor, with a hard depth bound.
    for (let depth = 0; depth < 64; depth++) {
      let raw;
      try { raw = read(path.posix.join(current, v2 ? 'memory.max' : 'memory.limit_in_bytes')); }
      catch (error) {
        // memory.max/current do not exist at the real cgroup-v2 hierarchy root.
        // A virtual namespace '/' is not proof of that root: require a readable
        // kernel-documented root-only cpuset marker, plus the memory controller.
        // Older kernels without the marker and all permission errors stay unknown.
        if (!v2 || current !== mountPoint || root !== '/' || error.code !== 'ENOENT') return result;
        const isolated = read(path.posix.join(current, 'cpuset.cpus.isolated'));
        const controllers = read(path.posix.join(current, 'cgroup.controllers')).split(/\s+/);
        if (!/^(?:[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)?$/.test(isolated)
            || !controllers.includes('memory')) return result;
        raw = 'max';
      }
      if (raw !== 'max' && !/^\d+$/.test(raw)) return result;
      readAny = true;
      const candidate = number(raw);
      if (candidate && (!limit || candidate < limit)) { limit = candidate; limited = true; }
      if (candidate && candidate < Number.MAX_SAFE_INTEGER) {
        const usedText = read(path.posix.join(current, v2 ? 'memory.current' : 'memory.usage_in_bytes'));
        if (!/^\d+$/.test(usedText) || !Number.isSafeInteger(Number(usedText))) return result;
        const remaining = Math.max(0, candidate - Number(usedText));
        free = free === null || free === undefined ? remaining : Math.min(free, remaining);
      }
      if (v2) {
        try {
          const cpu = read(path.posix.join(current, 'cpu.max')).split(' ');
          const quota = number(cpu[0]), period = number(cpu[1]);
          if (quota && period) result.cpuCount = Math.min(result.cpuCount || Infinity, Math.max(1, Math.ceil(quota / period)));
        } catch {} // No CPU quota claim when unavailable.
      }
      if (current === mountPoint) {
        if (readAny) {
          result.memoryBytes = limit || null;
          result.availableMemoryBytes = Number.isSafeInteger(free) && free >= 0 && limit ? Math.min(free, limit) : null;
          result.memorySource = limited ? (v2 ? 'cgroup_v2' : 'cgroup_v1') : (physical ? 'physical' : 'unknown');
        }
        break;
      }
      current = path.posix.dirname(current);
    }
  } catch {} // Inaccessible/incomplete namespace remains unknown.
  return result;
}
module.exports = {hostInfo};
