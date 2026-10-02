"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {inspectCapabilities} = require("./check-macos-capabilities.cjs");

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
