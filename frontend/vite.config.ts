import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { authenticatedProxyBoundary } from './scripts/local-proxy-policy.mjs';

const apiTarget = process.env.VITE_API_BASE_URL || process.env.OPENBUTLER_API_BASE_URL || "http://127.0.0.1:8010";
const isDesktopBuild = process.env.OPENBUTLER_DESKTOP_BUILD === "1";
const sessionToken = process.env.OPENBUTLER_SESSION_TOKEN;
if (sessionToken) {
  const target = new URL(apiTarget);
  if (!['http:', 'https:'].includes(target.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.username || target.password || process.env.VITE_API_BASE_URL) {
    throw new Error('Authenticated development requires a loopback OPENBUTLER_API_BASE_URL and same-origin browser requests.');
  }
}
const localProxy = {
  target: apiTarget,
  headers: sessionToken ? {'X-OpenButler-Session': sessionToken} : {},
};

export default defineConfig({
  plugins: [react(), ...(sessionToken ? [authenticatedProxyBoundary()] : [])],
  base: isDesktopBuild ? "./" : "/",
  preview: { host: '127.0.0.1', proxy: {} },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      "/api": localProxy,
      "/health": apiTarget
    }
  }
});
