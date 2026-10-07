'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Caller owns the application data directory. There is no renderer path input.
// Write-ahead intent survives process restart; no weights, keys or model prompts.
function createJournal(getDirectory, io = fs) {
  const filename = () => path.join(getDirectory(), 'model-catalog-download.json');
  return {
    readJournal() {
      let fd;
      try {
        const file = filename(), stat = io.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('journal_invalid');
        fd = io.openSync(file, 'r');
        const buffer = Buffer.alloc(4097);
        const size = io.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > 4096) throw new Error('journal_invalid');
        return JSON.parse(buffer.toString('utf8', 0, size));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('journal_unavailable');
      } finally { if (fd !== undefined) io.closeSync(fd); }
    },
    writeJournal(value) {
      const file = filename(), pending = `${file}.pending`;
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 4096) throw new Error('journal_invalid');
      let fd;
      try {
        // Exclusive creation avoids following a pre-existing temporary symlink.
        fd = io.openSync(pending, 'wx', 0o600);
        io.writeFileSync(fd, text, 'utf8'); io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
        io.renameSync(pending, file);
      } finally { if (fd !== undefined) io.closeSync(fd); }
    },
  };
}
module.exports = {createJournal};
