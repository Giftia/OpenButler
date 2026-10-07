"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {spawnSync} = require("node:child_process");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {inspectCapabilities} = require("./check-macos-capabilities.cjs");

test("explicit CLI starts the probe when Electron dynamically imports the entry", () => {
  const entry = pathToFileURL(join(__dirname, "check-macos-capabilities-cli.cjs")).href;
  const script = `
    import {createRequire} from "node:module";
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    let calls = 0;
    Module._load = function (request, parent, isMain) {
      if (request === "./check-macos-capabilities.cjs") {
        return {main() {calls++;}};
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    await import(${JSON.stringify(entry)});
    if (calls !== 1) throw new Error("Dynamic entry must start exactly one probe");
    console.log("dynamic-entry-started-once");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error || ""));
  assert.equal(result.stdout.trim(), "dynamic-entry-started-once");
});

function fixture(permission = "not-determined") {
  const calls = [];
  return {
    calls,
    input: {
      platform: "darwin",
      arch: "arm64",
      versions: {electron: "31.7.7", node: "20.0.0", chrome: "126.0.0"},
      systemPreferences: {
        getMediaAccessStatus(type) { calls.push(["status", type]); return permission; },
        isTrustedAccessibilityClient(prompt) { calls.push(["accessibility", prompt]); return false; },
      },
      screen: {getAllDisplays() { return [{size: {width: 1920, height: 1080}, scaleFactor: 2, label: "never retained", id: 999}]; }},
    },
  };
}

for (const permission of ["not-determined", "granted", "denied", "restricted", "unknown"]) {
  test(`reports ${permission} without requesting permission or claiming capture success`, () => {
    const {calls, input} = fixture(permission);
    const result = inspectCapabilities(input);
    assert.deepEqual(calls, [["status", "screen"], ["accessibility", false]]);
    assert.equal(result.screenPermission, permission);
    assert.equal(result.screenCaptureAttempted, false);
    assert.equal(result.permissionsRequested, false);
    assert.equal(result.permissionsModified, false);
    assert.equal(result.interactiveCaptureVerified, false);
    assert.equal(result.packagedMacAppVerified, false);
    assert.deepEqual(result.displays, [{width: 1920, height: 1080, scaleFactor: 2}]);
  });
}

test("rejects Linux instead of claiming native Mac validation", () => {
  const {calls, input} = fixture();
  assert.throws(() => inspectCapabilities({...input, platform: "linux"}), /must run on macOS/);
  assert.deepEqual(calls, []);
});

test("reports absent displays without claiming an interactive desktop", () => {
  const {input} = fixture();
  input.screen.getAllDisplays = () => [];
  const result = inspectCapabilities(input);
  assert.deepEqual(result.displays, []);
  assert.equal(result.interactiveCaptureVerified, false);
});

test("rejects unknown permission API values", () => {
  assert.throws(() => inspectCapabilities(fixture("unexpected-value").input));
});
