'use strict';

const http = require('node:http');
const {isIP} = require('node:net');
const {TextDecoder} = require('node:util');
const LIMITS = Object.freeze({timeoutMs: 3000, responseBytes: 256 * 1024, models: 128, modelId: 200});

function localEndpoint(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 500 || /[\s\\%?#@]/.test(raw)) {
    throw new Error('invalid_local_endpoint');
  }
  // Validate the literal authority before WHATWG can normalize short/octal/hex
  // IPv4. This matches the existing gateway's native-Ollama, local-only scope.
  const match = /^http:\/\/(localhost|\[[0-9a-f:.]+\]|[0-9.]+)(?::([0-9]{1,5}))?$/i.exec(raw);
  if (!match) throw new Error('invalid_local_endpoint');
  const literal = match[1].replace(/^\[|\]$/g, '').toLowerCase();
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid_local_endpoint');
  let address;
  if (literal === 'localhost') address = '127.0.0.1';
  else if (isIP(literal) === 4 && literal.split('.')[0] === '127') address = literal;
  else if (isIP(literal) === 6 && new URL(raw).hostname === '[::1]') address = '::1';
  else throw new Error('invalid_local_endpoint');
  return {endpoint: raw, address, port, host: match[1] + (match[2] === undefined ? '' : `:${match[2]}`)};
}

function installedMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, 'models') || !Array.isArray(input.models) || input.models.length > LIMITS.models) {
    throw new Error('invalid_local_model_response');
  }
  const models = [];
  for (const item of input.models) {
    const name = item?.name;
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, 'name')
      || typeof name !== 'string' || name.length > LIMITS.modelId
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(name) || name.includes('//')
      || name.split('/').some(part => part === '.' || part === '..')
      || (Object.hasOwn(item, 'model') && item.model !== name)) throw new Error('invalid_local_model_response');
    const metadata = {name, locality: 'unknown'};
    for (const key of ['remote_model', 'remote_host']) {
      if (!Object.hasOwn(item, key)) continue;
      const value = item[key];
      if (typeof value !== 'string' || value.length > (key === 'remote_model' ? LIMITS.modelId : 500)
        || /[\x00-\x20\x7f]/.test(value)) throw new Error('invalid_local_model_response');
      if (value && key === 'remote_model' && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
        throw new Error('invalid_local_model_response');
      }
      if (value && key === 'remote_host') {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('invalid_local_model_response');
        }
      }
      metadata[key] = value;
    }
    const selector = name.split(':').at(-1).toLowerCase();
    if (metadata.remote_model || metadata.remote_host || (name.includes(':')
      && (selector === 'cloud' || (!selector.includes('/') && selector.endsWith('-cloud'))))) {
      metadata.locality = 'remote';
    } else if (selector !== 'local' && item.model === name && Number.isSafeInteger(item.size) && item.size > 0
      && typeof item.digest === 'string' && /^[0-9a-f]{64}$/.test(item.digest)
      && item.details && ['gguf', 'safetensors'].includes(item.details.format)
      && !Object.hasOwn(item.details, 'remote_model') && !Object.hasOwn(item.details, 'remote_host')) {
      metadata.locality = 'local';
    }
    const prior = models.find(model => model.name === name);
    if (prior) {
      // Multiple aliases/runners must not become a local allow decision.
      if (JSON.stringify(prior) !== JSON.stringify(metadata)) throw new Error('invalid_local_model_response');
      prior.locality = 'unknown';
    } else models.push(metadata);
  }
  return models;
}

function installedIds(input) {
  return installedMetadata(input).filter(model => model.locality === 'local').map(model => model.name);
}

function createLocalModelDiscovery({request = http.request, timeoutMs = LIMITS.timeoutMs} = {}) {
  let busy = false;
  return async function listBuiltinLocalModels(input) {
    if (input?.protocol !== 'ollama_native') {
      return {ok: false, models: [], endpoint: '', error_code: 'unsupported_discovery_protocol'};
    }
    let selected;
    try { selected = localEndpoint(input.endpoint); }
    catch { return {ok: false, models: [], endpoint: '', error_code: 'invalid_local_endpoint'}; }
    if (busy) return {ok: false, models: [], endpoint: selected.endpoint, error_code: 'local_discovery_busy'};
    busy = true;
    try {
      return await new Promise(resolve => {
        let req, response, finished = false, bytes = 0;
        const chunks = [];
        const done = (error_code, modelMetadata = []) => {
          if (finished) return;
          finished = true; clearTimeout(timer);
          req?.destroy(); response?.destroy();
          for (const chunk of chunks) chunk.fill(0);
          chunks.length = 0;
          resolve({ok: !error_code, models: error_code ? [] : modelMetadata.filter(model => model.locality === 'local').map(model => model.name),
            modelMetadata: error_code ? [] : modelMetadata, endpoint: selected.endpoint,
            ...(error_code ? {error_code} : {})});
        };
        const timer = setTimeout(() => done('local_discovery_timeout'), timeoutMs);
        try {
          req = request({protocol: 'http:', hostname: selected.address, port: selected.port,
            method: 'GET', path: '/api/tags', agent: false, maxHeaderSize: 8192,
            headers: {Accept: 'application/json', Host: selected.host, Connection: 'close'}}, res => {
            response = res;
            if (finished) { res.destroy(); return; }
            if (res.statusCode !== 200) { done('local_discovery_http_error'); return; }
            const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            const encoding = res.headers['content-encoding'];
            if (type !== 'application/json' || (encoding && encoding !== 'identity')) {
              done('invalid_local_model_response'); return;
            }
            const length = res.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > LIMITS.responseBytes)) {
              done('local_discovery_response_too_large'); return;
            }
            res.on('data', chunk => {
              if (finished) return;
              bytes += chunk.length;
              if (bytes > LIMITS.responseBytes) { done('local_discovery_response_too_large'); return; }
              chunks.push(Buffer.from(chunk));
            });
            res.on('aborted', () => done('local_discovery_unavailable'));
            res.on('error', () => done('local_discovery_unavailable'));
            res.on('end', () => {
              if (finished) return;
              let buffer;
              try {
                buffer = Buffer.concat(chunks, bytes);
                const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer));
                done(null, installedMetadata(parsed));
              } catch { done('invalid_local_model_response'); }
              finally { buffer?.fill(0); }
            });
          });
          req.on('error', () => done('local_discovery_unavailable'));
          req.end();
        } catch { done('local_discovery_unavailable'); }
      });
    } finally { busy = false; }
  };
}

module.exports = {createLocalModelDiscovery, localEndpoint, installedIds, installedMetadata, LIMITS};
