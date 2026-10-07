import * as fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const productName = "OpenButler Nightly Windows";
const backendName = "openbutler-backend-windows-nightly.exe";

export function parseArguments(args, paths = path) {
  const values = {};
  for (const arg of args) {
    const match = /^--(output|version)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("Expected exactly --output and --version");
    values[match[1]] = match[2];
  }
  if (!values.output || !paths.isAbsolute(values.output) || paths.normalize(values.output) !== values.output
      || /[&|<>^%!"\r\n]/.test(values.output)) throw new Error("Output must be an explicit normalized absolute path");
  if (!/^0\.2\.0-nightly\.\d{8}\.[1-9]\d*$/.test(values.version || "")) throw new Error("Expected 0.2.0-nightly.YYYYMMDD.N version");
  return values;
}

// Reject links/junctions in all existing ancestors, not just the final leaf.
function plainDirectory(directory, io, paths) {
  const stat = io.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Output parent must be a plain existing directory");
  const parent = paths.dirname(directory);
  if (parent !== directory) plainDirectory(parent, io, paths);
}

export function assertX64Pe(file, io = fs) {
  const bytes = io.readFileSync(file);
  const offset = bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d ? bytes.readUInt32LE(0x3c) : -1;
  if (offset < 0 || offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x00004550
      || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error("Fresh executable is not Windows x64 PE");
}

export function buildNightly(args, {io = fs, run = spawnSync, platform = process.platform,
  arch = process.arch, env = process.env, desktopRoot = root, paths = path, node = process.execPath} = {}) {
  if (platform !== "win32" || arch !== "x64") throw new Error("Nightly unpacked build requires Windows x64 Node");
  const {output, version} = parseArguments(args, paths);
  if (Object.keys(env).some(key => /^(OPENBUTLER_|MINECONTEXT_|VITE_|ELECTRON_BUILDER_|CSC_|WIN_CSC_)/i.test(key))) {
    throw new Error("Build configuration overrides are forbidden for this Nightly entry");
  }
  if (io.lstatSync(output, {throwIfNoEntry: false})) throw new Error("Output already exists; choose a new directory");
  plainDirectory(paths.dirname(output), io, paths);
  const repo = paths.dirname(desktopRoot);
  const relativeOutput = paths.relative(repo, output);
  if (!relativeOutput || !relativeOutput.startsWith(".." + paths.sep) && !paths.isAbsolute(relativeOutput)) {
    throw new Error("Output must be outside the source checkout");
  }
  // Vite reads .env files even when no variables are inherited. Do not inspect
  // their contents or let a local endpoint/configuration enter this payload.
  for (const directory of [repo, desktopRoot, paths.join(repo, "frontend")]) {
    if (io.readdirSync(directory).map(name => name.toLowerCase()).some(name => name === "electron-builder.env" || name === ".env" || name.startsWith(".env.") && name !== ".env.example")) {
      throw new Error("Local dotenv files are forbidden for the Nightly build");
    }
  }
  const command = (exe, commandArgs, options = {}) => {
    const result = run(exe, commandArgs, {cwd: desktopRoot, env: {...env}, stdio: "inherit", ...options});
    if (result.error || result.status !== 0) throw new Error("Nightly build command failed: " + paths.basename(exe));
    return result.stdout?.trim();
  };
  const git = gitArgs => command("git", gitArgs, {encoding: "utf8", stdio: "pipe"});
  if (git(["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Nightly packaging requires a reviewed clean source commit");
  const commit = git(["rev-parse", "HEAD"]), tree = git(["rev-parse", "HEAD^{tree}"]);
  if (![commit, tree].every(value => /^[a-f0-9]{40}$/.test(value || ""))) throw new Error("Unverified source provenance");
  if (command("python", ["-c", "import struct; print(struct.calcsize('P') * 8)"], {encoding: "utf8", stdio: "pipe"}) !== "64") {
    throw new Error("Nightly backend requires Windows x64 Python");
  }
  // npm.cmd needs cmd on Windows; these arguments are all validated paths or
  // fixed literals. Node launches the installed npm CLI without shell parsing.
  const npm = env.npm_execpath;
  if (!npm || !paths.isAbsolute(npm) || !io.statSync(npm).isFile() || paths.basename(npm) !== "npm-cli.js") {
    throw new Error("Use npm run pack:nightly with the installed npm CLI");
  }
  // mkdir without recursive is an exclusive reservation. Never reuse outputs,
  // backend dist, helper binaries, or frontend assets from an earlier build.
  io.mkdirSync(output);
  const inputs = paths.join(output, "inputs"), packaged = paths.join(output, "packaged");
  io.mkdirSync(inputs);
  const frontend = paths.join(inputs, "frontend"), helper = paths.join(inputs, "helper");
  const backend = paths.join(inputs, "backend"), work = paths.join(output, "work");
  command(node, [npm, "--prefix", paths.join(repo, "frontend"), "run", "build", "--", "--outDir", frontend], {
    env: {...env, OPENBUTLER_DESKTOP_BUILD: "1", OPENBUTLER_DESKTOP_CHANNEL: "preview"},
  });
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    paths.join(desktopRoot, "scripts", "build-windows-public-window.ps1"), "-OutputDirectory", helper]);
  command("python", ["-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", backend,
    "--workpath", paths.join(work, "backend"), paths.join(desktopRoot, "desktop_backend.spec")]);
  const backendSource = paths.join(backend, "openbutler-backend.exe");
  assertX64Pe(backendSource, io);
  const helperSource = paths.join(helper, "windows-public-window.exe");
  assertX64Pe(helperSource, io);
  const digest = file => createHash("sha256").update(io.readFileSync(file)).digest("hex");
  const expectedHelperDigest = digest(helperSource);
  const ocr = paths.join(inputs, "ocr-languages");
  io.mkdirSync(ocr);
  for (const language of ["eng", "chi_sim"]) {
    const filename = `${language}.traineddata.gz`;
    const source = paths.join(desktopRoot, "node_modules", "@tesseract.js-data", language, "4.0.0", filename);
    if (!io.statSync(source).isFile() || io.statSync(source).size === 0) throw new Error("Offline OCR language missing");
    io.copyFileSync(source, paths.join(ocr, filename));
  }
  // Standalone allowlisted config: no reuse of package.build, installer config,
  // lifecycle scripts, stable version bumpers, or release/publish generators.
  const config = {
    extends: null, appId: "moe.giftia.openbutler.nightly.windows", productName,
    asar: true, asarUnpack: ["node_modules/**/*", "src/*.ps1", "src/windows-public-window.exe"],
    directories: {output: packaged},
    files: [{from: "src", to: "src", filter: ["**/*", "!windows-public-window.exe"]}, "package.json"],
    extraResources: [{from: "assets", to: "assets"}, {from: ocr, to: "ocr-languages"},
      {from: frontend, to: "frontend/dist"},
      // Copy after ASAR creation to the provider's existing physical path.
      // An external ASAR file-set can compute an invalid relative unpack path.
      {from: helperSource, to: "app.asar.unpacked/src/windows-public-window.exe"}, {from: backendSource, to: `backend/${backendName}`}],
    win: {icon: "assets/openbutler.ico", signAndEditExecutable: false, target: [{target: "dir", arch: ["x64"]}]},
    extraMetadata: {version, productName, openbutlerChannel: "preview",
      openbutlerVariant: "windows-nightly-unpacked-v1", openbutlerAppId: "moe.giftia.openbutler.nightly.windows",
      openbutlerSourceCommit: commit, openbutlerSourceTree: tree},
    publish: null,
  };
  const configPath = paths.join(output, "electron-builder-nightly.json");
  io.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {flag: "wx"});
  command(node, [paths.join(desktopRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    "--win", "--dir", "--x64", "--publish", "never", "--config", configPath]);
  const unpacked = paths.join(packaged, "win-unpacked");
  assertX64Pe(paths.join(unpacked, `${productName}.exe`), io);
  assertX64Pe(paths.join(unpacked, "resources", "backend", backendName), io);
  const packagedHelper = paths.join(unpacked, "resources", "app.asar.unpacked", "src", "windows-public-window.exe");
  assertX64Pe(packagedHelper, io);
  const helperSha256 = digest(packagedHelper);
  if (helperSha256 !== expectedHelperDigest) throw new Error("Packaged helper differs from fresh compiled helper");
  if (git(["rev-parse", "HEAD"]) !== commit || git(["rev-parse", "HEAD^{tree}"]) !== tree
      || git(["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Source changed during packaging; discard this candidate");
  }
  const result = {variant: "windows-nightly-unpacked-v1", version, commit, tree, architecture: "x64", helperSha256, unpacked};
  io.writeFileSync(paths.join(output, "build-provenance.json"), JSON.stringify(result, null, 2) + "\n", {flag: "wx"});
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(buildNightly(process.argv.slice(2)), null, 2));
}
