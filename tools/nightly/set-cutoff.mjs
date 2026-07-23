import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const path = join(root, "data", "nightly", "control", "stop-new-issues.flag");
mkdirSync(dirname(path), {recursive: true});
writeFileSync(path, `${new Date().toISOString()}\n`, "utf8");
console.log(path);
