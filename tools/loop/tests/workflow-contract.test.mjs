import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("scheduled L1 workflow is gated, pausable, and time bounded", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/loop-audit.yml"), "utf8");

  assert.match(workflow, /OPENBUTLER_L1_SCHEDULE_ENABLED/);
  assert.match(workflow, /timeout-minutes:\s*5/);
  assert.match(workflow, /pause-gate\.mjs/);
  assert.match(workflow, /steps\.pause\.outputs\.paused != 'true'/);
});
