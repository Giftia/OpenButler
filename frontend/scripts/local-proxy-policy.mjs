const peers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLocalProxyRequest(req) {
  if (!peers.has(req.socket?.remoteAddress)) return false;
  try {
    const host = req.headers.host;
    if (typeof host !== 'string') return false;
    const target = new URL(`http://${host}`);
    if (!hosts.has(target.hostname) || target.username || target.password ||
        target.pathname !== '/' || target.search || target.hash) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (typeof origin !== 'string') return false;
    const source = new URL(origin);
    return ['http:', 'https:'].includes(source.protocol) && source.host === host &&
      source.origin === origin;
  } catch {
    return false;
  }
}

export function authenticatedProxyBoundary() {
  return {
    name: 'local-session-proxy-boundary',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (isLocalProxyRequest(req)) return next();
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"detail":"local_proxy_forbidden"}');
      });
    },
  };
}
