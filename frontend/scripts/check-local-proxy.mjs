import assert from 'node:assert/strict';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer, preview } from 'vite';
import { isLocalProxyRequest } from './local-proxy-policy.mjs';

const request = (peer, host = '127.0.0.1:5173', origin) => ({
  socket: { remoteAddress: peer }, headers: { host, ...(origin === undefined ? {} : { origin }) },
});
assert.equal(isLocalProxyRequest(request('192.0.2.1')), false);
assert.equal(isLocalProxyRequest(request('127.0.0.1', 'attacker.invalid')), false);
assert.equal(isLocalProxyRequest(request('127.0.0.1', '127.0.0.1:5173', 'null')), false);
assert.equal(isLocalProxyRequest(request('127.0.0.1', '127.0.0.1:5173', 'https://attacker.invalid')), false);
assert.equal(isLocalProxyRequest(request('127.0.0.1', '127.0.0.1:5173', 'http://127.0.0.1:5173')), true);
assert.equal(isLocalProxyRequest(request('::1')), true);
let forwarded = 0;
const backend = httpServer((req, res) => {
  assert.equal(req.headers['x-openbutler-session'], 'synthetic-session');
  forwarded += 1;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
process.env.OPENBUTLER_API_BASE_URL = `http://127.0.0.1:${backend.address().port}`;
process.env.OPENBUTLER_SESSION_TOKEN = 'synthetic-session';
delete process.env.VITE_API_BASE_URL;
let dev, built;
try {
  dev = await createServer({ server: { port: 0 }, optimizeDeps: { noDiscovery: true, include: [] } });
  await dev.listen();
  const base = `http://127.0.0.1:${dev.httpServer.address().port}`;
  assert.equal((await fetch(`${base}/api/events`)).status, 200);
  assert.equal((await fetch(`${base}/api/events`, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/events`, { headers: { Host: 'attacker.invalid' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(forwarded, 1);
  built = await preview({ preview: { port: 0 } });
  const previewBase = `http://127.0.0.1:${built.httpServer.address().port}`;
  await fetch(`${previewBase}/api/events`);
  assert.equal(forwarded, 1, 'Preview must not inherit the credential-bearing API proxy');
  console.log('Local proxy policy: unit denial, authenticated dev, Origin/Host denial and preview isolation passed.');
} finally {
  await dev?.close();
  if (built) await new Promise(resolve => built.httpServer.close(resolve));
  await new Promise(resolve => backend.close(resolve));
}
