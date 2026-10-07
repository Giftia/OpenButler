"use strict";

const assert = require("node:assert/strict");

function inspectCapabilities({platform, arch, versions, systemPreferences, screen}) {
  assert.equal(platform, "darwin", "This native capability probe must run on macOS");
  const screenPermission = systemPreferences.getMediaAccessStatus("screen");
  assert.ok(["not-determined", "granted", "denied", "restricted", "unknown"].includes(screenPermission));
  // false explicitly avoids showing a macOS Accessibility permission prompt.
  const accessibilityTrusted = systemPreferences.isTrustedAccessibilityClient(false);
  const displays = screen.getAllDisplays().map(({size, scaleFactor}) => ({
    width: size.width,
    height: size.height,
    scaleFactor,
  }));
  return {
    platform,
    arch,
    versions: {electron: versions.electron, node: versions.node, chrome: versions.chrome},
    screenPermission,
    accessibilityTrusted,
    displays,
    screenCaptureAttempted: false,
    permissionsRequested: false,
    permissionsModified: false,
    interactiveCaptureVerified: false,
    packagedMacAppVerified: false,
    boundary: "Metadata only. Runner permission state does not validate the end-user TCC flow or prove screen capture works.",
  };
}

async function main() {
  const {app, systemPreferences, screen} = require("electron");
  const {mkdirSync, writeFileSync} = require("node:fs");
  const {dirname} = require("node:path");
  if (process.env.OPENBUTLER_MACOS_PROBE_USER_DATA) {
    mkdirSync(process.env.OPENBUTLER_MACOS_PROBE_USER_DATA, {recursive: true});
    app.setPath("userData", process.env.OPENBUTLER_MACOS_PROBE_USER_DATA);
  }
  const timeout = setTimeout(() => {
    console.error("macOS capability probe timed out before completion");
    app.exit(1);
  }, 45000);
  try {
    await app.whenReady();
    const result = inspectCapabilities({
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      systemPreferences,
      screen,
    });
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (process.env.OPENBUTLER_MACOS_PROBE_OUTPUT) {
      mkdirSync(dirname(process.env.OPENBUTLER_MACOS_PROBE_OUTPUT), {recursive: true});
      writeFileSync(process.env.OPENBUTLER_MACOS_PROBE_OUTPUT, serialized, {mode: 0o600});
    }
    console.log(serialized);
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {inspectCapabilities, main};
if (require.main === module) main();
