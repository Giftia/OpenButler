// Synthetic-only checks; never loads Electron, a screen capture, or a model route.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";

async function loadTs(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const {outputText} = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext}});
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const {clampMask, sameMask, pointInImage, maskFromPoints, resizeMask, moveMask, validImageBounds} = await loadTs("../src/lib/maskGeometry.ts");
const {createPrivacyPreviewGate} = await loadTs("../src/lib/privacyPreviewGate.ts");
const bounds = {width: 1920, height: 1080};

function inBounds(rect, size = bounds) {
  for (const value of Object.values(rect)) assert.ok(Number.isSafeInteger(value));
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1);
  assert.ok(rect.x + rect.width <= size.width && rect.y + rect.height <= size.height);
}

test("CSS-scaled pointer coordinates map into natural image pixels", () => {
  assert.deepEqual(pointInImage({x: 580, y: 320}, {left: 100, top: 50, width: 960, height: 540}, bounds), {x: 960, y: 540});
  assert.deepEqual(pointInImage({x: 346, y: 242}, {left: 10, top: 53, width: 672, height: 378}, bounds), {x: 960, y: 540});
  assert.deepEqual(pointInImage({x: -100, y: 3000}, {left: 50, top: 30, width: 640, height: 360}, bounds), {x: 0, y: 1080});
  assert.equal(pointInImage({x: 0, y: 0}, {left: 0, top: 0, width: 0, height: 0}, bounds), null);
  assert.equal(pointInImage({x: NaN, y: 0}, {left: 0, top: 0, width: 10, height: 10}, bounds), null);
});

test("reverse drawing rounds outwards and clamps every image edge", () => {
  assert.deepEqual(maskFromPoints({x: 300.2, y: 400.7}, {x: 99.8, y: 100.1}, bounds), {x: 99, y: 100, width: 202, height: 301});
  assert.deepEqual(maskFromPoints({x: -100, y: -100}, {x: 4000, y: 3000}, bounds), {x: 0, y: 0, width: 1920, height: 1080});
  assert.deepEqual(maskFromPoints({x: 1920, y: 1080}, {x: 1920, y: 1080}, bounds), {x: 1919, y: 1079, width: 1, height: 1});
});

test("numeric fallback clamps invalid numbers, dimensions, and out-of-range origins", () => {
  assert.deepEqual(clampMask({x: -10, y: 2000, width: Infinity, height: -5}, bounds), {x: 0, y: 1079, width: 1, height: 1});
  assert.deepEqual(clampMask({x: 1900, y: 1000, width: 100, height: 100}, bounds), {x: 1900, y: 1000, width: 20, height: 80});
  assert.deepEqual(clampMask({x: 0.4, y: 1.6, width: 20.2, height: 30.9}, bounds), {x: 0, y: 2, width: 20, height: 31});
  assert.deepEqual(clampMask({x: NaN, y: NaN, width: NaN, height: NaN}, {width: 1, height: 1}), {x: 0, y: 0, width: 1, height: 1});
  assert.ok(sameMask(clampMask({x: 2, y: 3, width: 4, height: 5}, bounds), {x: 2, y: 3, width: 4, height: 5}));
  assert.equal(validImageBounds({width: 0, height: 10}), false);
  assert.equal(validImageBounds({width: 1.5, height: 10}), false);
});

test("all four resize handles preserve opposite corners and allow crossing", () => {
  const rect = {x: 100, y: 100, width: 200, height: 100};
  assert.deepEqual(resizeMask(rect, "nw", {x: -50, y: -20}, bounds), {x: 50, y: 80, width: 250, height: 120});
  assert.deepEqual(resizeMask(rect, "ne", {x: 50, y: -20}, bounds), {x: 100, y: 80, width: 250, height: 120});
  assert.deepEqual(resizeMask(rect, "sw", {x: -50, y: 20}, bounds), {x: 50, y: 100, width: 250, height: 120});
  assert.deepEqual(resizeMask(rect, "se", {x: 50, y: 20}, bounds), {x: 100, y: 100, width: 250, height: 120});
  assert.deepEqual(resizeMask(rect, "nw", {x: 300, y: 200}, bounds), {x: 300, y: 200, width: 100, height: 100});
});

test("keyboard movement preserves the rectangle size at image edges", () => {
  assert.deepEqual(moveMask({x: 100, y: 100, width: 200, height: 100}, {x: 10000, y: -10000}, bounds), {x: 1720, y: 0, width: 200, height: 100});
});

test("portrait, one-pixel, and wide-image geometry stays bounded", () => {
  for (const size of [{width: 1, height: 1}, {width: 300, height: 900}, bounds, {width: 4096, height: 128}]) {
    for (const start of [{x: -20, y: -40}, {x: 0, y: 0}, {x: size.width, y: size.height}, {x: 12.4, y: 20.8}]) {
      for (const end of [{x: 5000, y: 5000}, {x: 0, y: 0}, {x: 54.3, y: 30.1}]) {
        const drawn = maskFromPoints(start, end, size);
        inBounds(drawn, size);
        for (const corner of ["nw", "ne", "sw", "se"]) {
          inBounds(resizeMask(drawn, corner, {x: -6000, y: 6000}, size), size);
        }
      }
    }
  }
});

test("every edit rejects a pending preview even when values are later restored", () => {
  const gate = createPrivacyPreviewGate();
  const ticket = gate.request();
  assert.equal(gate.isCurrent(ticket), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(ticket), false);
  gate.invalidate();
  assert.equal(gate.isCurrent(ticket), false);
  assert.equal(gate.isCurrent(gate.request()), true);
});

test("new requests, close/reopen, and StrictMode lifecycle reject stale replies", () => {
  const gate = createPrivacyPreviewGate();
  const older = gate.request();
  const newer = gate.request();
  assert.equal(gate.isCurrent(older), false);
  assert.equal(gate.isCurrent(newer), true);
  gate.close();
  assert.equal(gate.isCurrent(newer), false);
  gate.open();
  assert.equal(gate.isCurrent(newer), false);
  const reopened = gate.request();
  assert.equal(gate.isCurrent(reopened), true);
  gate.close();
  gate.open();
  assert.equal(gate.isCurrent(reopened), false);
});

test("activation keeps full desktop closed; public-window approval stays scoped to a loaded current preview", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const activation = app.slice(app.indexOf("function PreviewActivation("), app.indexOf("function FirstRunGuide("));
  assert.match(activation, /const fullDesktopAvailable = false/);
  assert.equal((activation.match(/if \(operation\.current \|\| editing \|\| statusData\?\.recording.active \|\| !fullDesktopAvailable\) return/g) ?? []).length, 2);
  assert.match(activation, /fullDesktopAvailable && captureScope === "screen"/);
  assert.doesNotMatch(activation, /getCaptureDisplays|full_desktop.supported|localStorage|sessionStorage|getDisplayMedia|captureScreen/);
  const publicWindow = readFileSync(new URL("../src/components/PublicWindowCaptureSetup.tsx", import.meta.url), "utf8");
  assert.match(publicWindow, /preview\.fresh && !!preview\.bounds/);
  assert.match(publicWindow, /preview\.configKey === configKey && gate\.current\.isCurrent\(preview\.ticket\)/);
  assert.match(publicWindow, /!confirmed \|\| !fresh \|\| !preview/);
  assert.match(publicWindow, /if \(!gate\.current\.isCurrent\(ticket\)\) return/);
  assert.match(publicWindow, /previewDataUrl\.startsWith\("data:image\/png;base64,"\)/);
  assert.match(publicWindow, /gate\.current\.close\(\)/);
  assert.match(publicWindow, /operation\.current = "start"/);
  assert.match(publicWindow, /await pauseFailedStart\(\)/);
});
