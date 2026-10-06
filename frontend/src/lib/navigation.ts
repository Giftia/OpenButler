export function currentAppPath() {
  return window.location.protocol === "file:"
    ? window.location.hash.slice(1) || "/butler"
    : window.location.pathname;
}

export function replaceAppPath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid application route");
  // File-loaded Electron pages must retain the trusted index.html document URL.
  window.history.replaceState(null, "", window.location.protocol === "file:" ? `#${path}` : path);
}
