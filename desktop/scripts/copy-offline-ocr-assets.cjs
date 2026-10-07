"use strict";

const {copyFileSync, mkdirSync, statSync} = require("node:fs");
const {join} = require("node:path");

const root = join(__dirname, "..");
const destination = join(root, ".tmp", "ocr-languages");
mkdirSync(destination, {recursive: true});

for (const language of ["eng", "chi_sim"]) {
  const file = `${language}.traineddata.gz`;
  const source = join(root, "node_modules", "@tesseract.js-data", language, "4.0.0", file);
  if (!statSync(source, {throwIfNoEntry: false})?.isFile()) {
    throw new Error(`Offline OCR asset missing: ${source}`);
  }
  copyFileSync(source, join(destination, file));
}
