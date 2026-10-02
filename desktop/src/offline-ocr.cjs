"use strict";

const {statSync} = require("node:fs");
const {dirname, join, resolve} = require("node:path");
const {createWorker, OEM} = require("tesseract.js");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CORE_VARIANTS = ["", "-simd", "-lstm", "-simd-lstm"];

function assetPaths(assetRoot) {
  const packaged = __dirname.includes("app.asar");
  const root = resolve(assetRoot || dirname(__dirname).replace(/app\.asar(?=[\\/])/, "app.asar.unpacked"));
  const modules = join(root, "node_modules");
  const corePath = join(modules, "tesseract.js-core");
  const langPath = assetRoot || !packaged
    ? join(root, ".tmp", "ocr-languages")
    : join(process.resourcesPath, "ocr-languages");
  return {
    workerPath: join(modules, "tesseract.js", "src", "worker-script", "node", "index.js"),
    corePath,
    langPath,
  };
}

function requireLocalAssets(paths) {
  const files = [paths.workerPath, ...["eng", "chi_sim"].map((lang) => join(paths.langPath, `${lang}.traineddata.gz`))];
  for (const variant of CORE_VARIANTS) {
    files.push(join(paths.corePath, `tesseract-core${variant}.wasm.js`));
    files.push(join(paths.corePath, `tesseract-core${variant}.wasm`));
  }
  for (const path of files) {
    if (!statSync(path, {throwIfNoEntry: false})?.isFile()) {
      throw new Error(`Offline OCR asset missing: ${path}`);
    }
  }
}

function imageSize(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new TypeError("Offline OCR requires a PNG Buffer");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height) throw new TypeError("Offline OCR requires nonempty PNG dimensions");
  return {width, height};
}

function extractWords(blocks, width, height) {
  if (!Array.isArray(blocks)) throw new Error("Offline OCR returned no word geometry");
  const words = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const box = word.bbox;
          if (typeof word.text !== "string" || !box ||
              ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) {
            throw new Error("Offline OCR returned invalid word geometry");
          }
          const bbox = {
            x0: Math.max(0, Math.floor(box.x0)),
            y0: Math.max(0, Math.floor(box.y0)),
            x1: Math.min(width, Math.ceil(box.x1)),
            y1: Math.min(height, Math.ceil(box.y1)),
          };
          if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) {
            throw new Error("Offline OCR returned out-of-bounds word geometry");
          }
          if (word.text.trim()) words.push({text: word.text, bbox});
        }
      }
    }
  }
  return words;
}

function createOfflineOcr(options = {}) {
  const paths = assetPaths(options.assetRoot);
  let workerPromise;
  let disposed = false;
  let pending = Promise.resolve();

  async function getWorker() {
    if (!workerPromise) {
      requireLocalAssets(paths);
      workerPromise = createWorker(["eng", "chi_sim"], OEM.LSTM_ONLY, {
        workerPath: paths.workerPath,
        corePath: paths.corePath,
        langPath: paths.langPath,
        cacheMethod: "none",
      });
    }
    return workerPromise;
  }

  function recognize(png) {
    if (disposed) return Promise.reject(new Error("Offline OCR is disposed"));
    const job = pending.then(async () => {
      const {width, height} = imageSize(png);
      const worker = await getWorker();
      const {data} = await worker.recognize(png, {}, {text: true, blocks: true});
      if (typeof data?.text !== "string") throw new Error("Offline OCR returned no text result");
      const words = extractWords(data.blocks, width, height);
      if (data.text.trim() && !words.length) throw new Error("Offline OCR returned text without word boxes");
      return {text: data.text, words};
    });
    pending = job.catch(() => {});
    return job;
  }

  async function dispose() {
    disposed = true;
    await pending;
    if (workerPromise) {
      const worker = await workerPromise.catch(() => undefined);
      if (worker) await worker.terminate();
      workerPromise = undefined;
    }
  }

  return {recognize, dispose};
}

module.exports = {createOfflineOcr};
