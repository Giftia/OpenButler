'use strict';
const http = require('node:http');
const {TextDecoder} = require('node:util');
const LIMITS = Object.freeze({jsonBytes: 512 * 1024, jsonTimeoutMs: 5000,
  streamBytes: 32 * 1024 * 1024, lineBytes: 8192, streamRecords: 100000,
  idleTimeoutMs: 60000, pullTimeoutMs: 2 * 60 * 60 * 1000, headerBytes: 8192});
const error = code => Object.assign(new Error(code), {code});

// A deliberately tiny transport. Callers supply a previously parsed literal
// loopback endpoint and fixed paths only. No redirects, proxies, cookies or keys.
function createTransport({request = http.request, limits = LIMITS} = {}) {
  function exchange(selected, pathname, body, {signal, onRecord} = {}) {
    const streaming = typeof onRecord === 'function';
    if (!['/api/version', '/api/tags', '/api/show', '/api/pull'].includes(pathname))
      return Promise.reject(error('catalog_invalid_request'));
    if (signal?.aborted) return Promise.reject(error('catalog_request_interrupted'));
    return new Promise((resolve, reject) => {
      let req, res, ended = false, bytes = 0, records = 0, line = Buffer.alloc(0), idle;
      const chunks = [];
      const finish = (failure, value) => {
        if (ended) return;
        ended = true; clearTimeout(deadline); clearTimeout(idle);
        signal?.removeEventListener('abort', abort);
        req?.destroy(); res?.destroy();
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0; line.fill(0);
        if (failure) reject(error(failure)); else resolve(value);
      };
      const abort = () => finish('catalog_request_interrupted');
      const deadline = setTimeout(() => finish('catalog_request_timeout'), streaming ? limits.pullTimeoutMs : limits.jsonTimeoutMs);
      const touch = () => {
        clearTimeout(idle);
        if (streaming) idle = setTimeout(() => finish('catalog_request_timeout'), limits.idleTimeoutMs);
      };
      function parse(buffer) {
        try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)); }
        catch { throw error('catalog_invalid_response'); }
      }
      function record(buffer) {
        if (!buffer.length) return;
        if (++records > limits.streamRecords || buffer.length > limits.lineBytes) throw error('catalog_response_too_large');
        const parsed = parse(buffer);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error('catalog_invalid_response');
        onRecord(parsed);
      }
      signal?.addEventListener('abort', abort, {once: true}); touch();
      try {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        req = request({protocol: 'http:', hostname: selected.address, port: selected.port,
          method: payload ? 'POST' : 'GET', path: pathname, agent: false, maxHeaderSize: limits.headerBytes,
          headers: {Accept: streaming ? 'application/x-ndjson' : 'application/json', Host: selected.host,
            Connection: 'close', ...(payload ? {'Content-Type': 'application/json', 'Content-Length': payload.length} : {})}}, response => {
          res = response;
          if (ended) { res.destroy(); return; }
          if (res.statusCode !== 200) { finish('catalog_http_error'); return; }
          const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const encoding = res.headers['content-encoding'];
          if (!(streaming ? ['application/x-ndjson', 'application/json'].includes(type) : type === 'application/json')
              || (encoding && encoding !== 'identity')) { finish('catalog_invalid_response'); return; }
          const max = streaming ? limits.streamBytes : limits.jsonBytes;
          const length = res.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > max)) {
            finish('catalog_response_too_large'); return;
          }
          res.on('data', chunk => {
            if (ended) return;
            bytes += chunk.length; touch();
            if (bytes > max) { finish('catalog_response_too_large'); return; }
            if (!streaming) { chunks.push(Buffer.from(chunk)); return; }
            try {
              // Process one line at a time, not an unbounded concatenation of a
              // malicious giant chunk. Each residual line has its own byte cap.
              let start = 0;
              for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
                if (line.length + i - start > limits.lineBytes) throw error('catalog_response_too_large');
                const next = Buffer.concat([line, chunk.subarray(start, i)]);
                line.fill(0); line = Buffer.alloc(0);
                try { record(next); } finally { next.fill(0); }
                start = i + 1;
              }
              if (line.length + chunk.length - start > limits.lineBytes) throw error('catalog_response_too_large');
              const next = Buffer.concat([line, chunk.subarray(start)]); line.fill(0); line = next;
            } catch (e) { finish(e.code || 'catalog_invalid_response'); }
          });
          res.on('aborted', () => finish('catalog_unavailable'));
          res.on('error', () => finish('catalog_unavailable'));
          res.on('end', () => {
            if (ended) return;
            try {
              if (streaming) { record(line); finish(null, null); }
              else { const buffer = Buffer.concat(chunks, bytes);
                try { finish(null, parse(buffer)); } finally { buffer.fill(0); }
              }
            } catch (e) { finish(e.code || 'catalog_invalid_response'); }
          });
        });
        req.on('error', () => finish('catalog_unavailable'));
        req.end(payload);
      } catch { finish('catalog_unavailable'); }
    });
  }
  return {json: (selected, path, body, options) => exchange(selected, path, body, options),
    pull: (selected, model, options) => exchange(selected, '/api/pull', {model, stream: true}, options)};
}
module.exports = {createTransport, LIMITS};
