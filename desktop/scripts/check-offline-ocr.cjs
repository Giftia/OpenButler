"use strict";

const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const {appendFileSync, existsSync, mkdtempSync, rmSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {PassThrough} = require("node:stream");
const {PNG} = require("pngjs");
const PImage = require("pureimage");
const {createOfflineOcr} = require(process.env.OFFLINE_OCR_MODULE || "../src/offline-ocr.cjs");

if (process.env.OFFLINE_OCR_DENY_NETWORK === "1") {
  if (!require("node:worker_threads").isMainThread) {
    appendFileSync(process.env.OFFLINE_OCR_WORKER_PRELOAD, "worker preload active\n");
  }
  const blocked = () => {
    appendFileSync(process.env.OFFLINE_OCR_NETWORK_ATTEMPTS, "network attempt\n");
    throw new Error("Offline OCR attempted network access");
  };
  global.fetch = blocked;
  for (const name of ["node:http", "node:https", "node:net", "node:tls"]) {
    const module = require(name);
    for (const method of ["get", "request", "connect", "createConnection"]) {
      if (typeof module[method] === "function") module[method] = blocked;
    }
  }
}

async function syntheticPng() {
  const font = PImage.registerFont(
    join(__dirname, "..", "node_modules", "@expo-google-fonts", "roboto", "700Bold", "Roboto_700Bold.ttf"),
    "SyntheticRoboto",
  );
  font.loadSync();
  const image = PImage.make(900, 170);
  const context = image.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 900, 170);
  context.fillStyle = "black";
  context.font = "72px SyntheticRoboto";
  context.fillText("SECRET12345", 25, 115);
  const stream = new PassThrough();
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  await PImage.encodePNGToStream(image, stream);
  const buffer = Buffer.concat(chunks);
  assert.equal(PNG.sync.read(buffer).width, 900);
  return buffer;
}

async function check() {
  const image = await syntheticPng();
  if (process.env.OFFLINE_OCR_CHILD === "1") {
    const ocr = createOfflineOcr();
    try {
      const result = await ocr.recognize(image);
      assert.match(result.text.replace(/\s/g, ""), /SECRET12345/i);
      assert.ok(result.words.some((word) => /SECRET/i.test(word.text)));
      for (const {bbox} of result.words) {
        assert.ok(bbox.x0 >= 0 && bbox.y0 >= 0 && bbox.x1 <= 900 && bbox.y1 <= 170);
        assert.ok(bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0);
      }
    } finally {
      await ocr.dispose();
    }
    if (process.env.OFFLINE_OCR_MODULE) console.log("packaged OCR recognition ok");
    return;
  }

  const temp = mkdtempSync(join(tmpdir(), "openbutler-ocr-test-"));
  try {
    const attemptFile = join(temp, "network-attempts.txt");
    const workerPreloadFile = join(temp, "worker-preload.txt");
    const child = spawnSync(process.execPath, ["--require", __filename, "-e", `require(${JSON.stringify(__filename)}).check()`], {
      cwd: join(__dirname, ".."),
      env: {
        ...process.env,
        OFFLINE_OCR_CHILD: "1",
        OFFLINE_OCR_DENY_NETWORK: "1",
        OFFLINE_OCR_NETWORK_ATTEMPTS: attemptFile,
        OFFLINE_OCR_WORKER_PRELOAD: workerPreloadFile,
      },
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(child.status, 0, (child.stderr || child.error?.message || "").slice(-1200));
    assert.equal(existsSync(workerPreloadFile), true, "network guard did not load in OCR worker");
    assert.equal(existsSync(attemptFile), false, "OCR attempted network access");

    const missing = createOfflineOcr({assetRoot: join(temp, "missing-assets")});
    await assert.rejects(missing.recognize(Buffer.from("invalid")), /PNG Buffer/);
    await assert.rejects(missing.recognize(image), /Offline OCR asset missing/);
    await missing.dispose();
    await assert.rejects(missing.recognize(image), /disposed/);
    console.log("offline OCR synthetic text, boxes, no-network and missing-assets checks ok");
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
}

module.exports = {check};

if (require.main === module) {
  check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
