import {readFileSync, existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(desktopRoot, "..");
const indexPath = resolve(repoRoot, "frontend", "dist", "index.html");

if (!existsSync(indexPath)) {
  throw new Error("frontend/dist/index.html does not exist. Run npm run build:frontend in desktop first.");
}

const html = readFileSync(indexPath, "utf8");
if (html.includes('src="/assets/') || html.includes('href="/assets/')) {
  throw new Error("Desktop frontend build still uses absolute /assets paths");
}
if (!html.includes('src="./assets/') || !html.includes('href="./assets/')) {
  throw new Error("Desktop frontend build does not use ./assets paths");
}

console.log("desktop frontend asset paths ok");
