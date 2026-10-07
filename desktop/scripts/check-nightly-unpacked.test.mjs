import assert from "node:assert/strict";
import {test} from "node:test";
import path from "node:path";
import {buildNightly, parseArguments, assertX64Pe} from "./build-nightly-unpacked.mjs";

const paths = path.win32;
const output = "C:\\builds\\nightly-20261007-1";
const args = [`--output=${output}`, "--version=0.2.0-nightly.20261007.1"];
const pe = Buffer.alloc(128);
pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(64, 0x3c); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
const directory = {isDirectory: () => true, isSymbolicLink: () => false};
const file = {isFile: () => true, size: 100};
function harness(options = {}) {
  const calls = [], writes = [], copies = [], directories = [];
  const io = {
    lstatSync(name) {
      if (name === output) return options.existing ? directory : undefined;
      if (options.linkParent && name === "C:\\builds") return {...directory, isSymbolicLink: () => true};
      return directory;
    },
    statSync: () => file,
    readdirSync: () => options.dotenv ? [".env.local"] : options.builderEnv ? ["electron-builder.env"] : options.mixedCaseEnv ? ["Electron-Builder.Env"] : options.mixedCaseDotenv ? [".ENV.production"] : ["package.json"],
    mkdirSync: name => directories.push(name),
    readFileSync(name) {
      if (options.missingBackend && name.endsWith("openbutler-backend.exe")) return Buffer.alloc(0);
      if (options.changedHelper && name.includes("app.asar.unpacked")) { const changed = Buffer.from(pe); changed[100] = 1; return changed; }
      return pe;
    },
    copyFileSync: (...values) => copies.push(values),
    writeFileSync: (...values) => writes.push(values),
  };
  let statusReads = 0;
  const run = (exe, commandArgs, settings) => {
    calls.push({exe, args: commandArgs, settings});
    if (exe === "git") return {status: 0, stdout: commandArgs[0] === "status"
      ? (options.dirty || options.sourceChanged && ++statusReads > 1 ? " M src/main.cjs" : "") : "1".repeat(40)};
    if (exe === "python" && commandArgs[0] === "-c") return {status: 0, stdout: options.python32 ? "32" : "64"};
    if (options.failCommand && commandArgs.includes(options.failCommand)) return {status: 1};
    return {status: 0};
  };
  return {calls, writes, copies, directories, build: () => buildNightly(args, {
    io, run, paths, platform: "win32", arch: "x64", desktopRoot: "C:\\source\\desktop", node: "C:\\node\\node.exe",
    env: {npm_execpath: "C:\\node\\npm-cli.js", ...(options.env || {})}, ...options.overrides,
  })};
}

test("Nightly produces a fresh x64 unpacked plan with its own frontend, helper, backend and OCR", () => {
  const h = harness(), result = h.build();
  assert.equal(result.architecture, "x64");
  assert.equal(result.unpacked, paths.join(output, "packaged", "win-unpacked"));
  const frontend = h.calls.find(call => call.args.includes("--outDir"));
  assert.equal(frontend.settings.env.OPENBUTLER_DESKTOP_BUILD, "1");
  assert.equal(frontend.settings.env.OPENBUTLER_DESKTOP_CHANNEL, "preview");
  assert.equal(frontend.args.at(-1), paths.join(output, "inputs", "frontend"));
  const helper = h.calls.find(call => call.exe === "powershell.exe");
  assert.equal(helper.args.at(-2), "-OutputDirectory");
  assert.equal(helper.args.at(-1), paths.join(output, "inputs", "helper"));
  const backend = h.calls.find(call => call.args.includes("PyInstaller"));
  assert.ok(backend.args.includes("--clean"));
  assert.equal(backend.args[backend.args.indexOf("--distpath") + 1], paths.join(output, "inputs", "backend"));
  assert.equal(h.copies.length, 2);
  assert.ok(h.copies.every(([, target]) => target.startsWith(paths.join(output, "inputs", "ocr-languages"))));
  const config = JSON.parse(h.writes.find(([name]) => name.endsWith("electron-builder-nightly.json"))[1]);
  assert.equal(config.productName, "OpenButler Nightly Windows");
  assert.equal(config.extraMetadata.openbutlerVariant, "windows-nightly-unpacked-v1");
  assert.equal(config.extraMetadata.openbutlerChannel, "preview");
  assert.equal(config.extraMetadata.openbutlerSourceCommit, "1".repeat(40));
  assert.ok(config.asarUnpack.includes("src/windows-public-window.exe"));
  assert.deepEqual(config.extraResources.find(resource => resource.to === "app.asar.unpacked/src/windows-public-window.exe"),
    {from: paths.join(output, "inputs", "helper", "windows-public-window.exe"), to: "app.asar.unpacked/src/windows-public-window.exe"});
  assert.ok(!config.files.some(item => item?.from === paths.join(output, "inputs", "helper")));
  assert.equal(config.extraResources.at(-1).to, "backend/openbutler-backend-windows-nightly.exe");
  assert.equal(config.nsis, undefined);
  assert.equal(config.extends, null);
  assert.equal(config.publish, null);
  assert.deepEqual(config.win.target, [{target: "dir", arch: ["x64"]}]);
  const builder = h.calls.find(call => call.args.includes("--dir"));
  assert.ok(builder.args[0].endsWith("electron-builder\\out\\cli\\cli.js"));
  assert.deepEqual(builder.args.slice(1), ["--win", "--dir", "--x64", "--publish", "never", "--config", paths.join(output, "electron-builder-nightly.json")]);
  assert.ok(h.calls.indexOf(backend) < h.calls.indexOf(builder));
  assert.ok(h.writes.every(([name, , mode]) => name.startsWith(output + "\\") && mode.flag === "wx"));
  assert.ok(!h.calls.some(call => call.args.some(arg => /nsis|build-installer|build-preview-installer|stable-release|bump-version/i.test(arg))));
});

test("ambiguous build arguments fail closed", () => {
  for (const values of [[], ["--output=relative", args[1]], [args[0], args[1], args[1]],
    [args[0], "--version=0.1.9"], [...args, "--arch=arm64"], [...args, "--publish=always"],
    ["--output=C:\\builds\\..\\old", args[1]], ["--output=C:\\builds\\%USERNAME%", args[1]]]) {
    assert.throws(() => parseArguments(values, paths));
  }
});

test("existing output, reparse parent, dirty source, dotenv and inherited config never build", () => {
  for (const options of [{existing: true}, {linkParent: true}, {dirty: true}, {dotenv: true}, {builderEnv: true}, {mixedCaseEnv: true}, {mixedCaseDotenv: true},
    {env: {OPENBUTLER_DESKTOP_CHANNEL: "stable"}}, {env: {VITE_API_BASE_URL: "https://example.invalid"}},
    {env: {ELECTRON_BUILDER_CONFIG: "old.json"}}, {env: {CSC_LINK: "old-certificate"}}]) {
    const h = harness(options);
    assert.throws(h.build);
    assert.equal(h.directories.length, 0);
    assert.ok(h.calls.every(call => call.exe === "git"));
  }
});

test("unsupported Node or Python architecture cannot package", () => {
  for (const options of [{overrides: {platform: "linux"}}, {overrides: {arch: "arm64"}}, {python32: true}]) {
    const h = harness(options); assert.throws(h.build); assert.equal(h.directories.length, 0);
  }
});

test("failed fresh frontend, helper or backend never invokes electron-builder", () => {
  for (const failCommand of ["--outDir", "-OutputDirectory", "PyInstaller"]) {
    const h = harness({failCommand}); assert.throws(h.build);
    assert.equal(h.writes.length, 0);
    assert.ok(!h.calls.some(call => call.args.includes("--dir")));
  }
});

test("missing newly built backend cannot reuse stale desktop/dist payload", () => {
  const h = harness({missingBackend: true}); assert.throws(h.build, /Windows x64 PE/);
  assert.equal(h.writes.length, 0);
  assert.ok(!h.calls.some(call => call.args.includes("--dir")));
});

test("PE verification rejects truncated, non-Windows and ARM64 executables", () => {
  const arm64 = Buffer.from(pe); arm64.writeUInt16LE(0xaa64, 68);
  const badOffset = Buffer.from(pe); badOffset.writeUInt32LE(0xffffffff, 0x3c);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(80), arm64, badOffset]) {
    assert.throws(() => assertX64Pe("synthetic.exe", {readFileSync: () => bytes}), /Windows x64 PE/);
  }
});


test("a source mutation during packaging prevents successful provenance publication", () => {
  const h = harness({sourceChanged: true}); assert.throws(h.build, /Source changed during packaging/);
  assert.ok(h.calls.some(call => call.args.includes("--dir")));
  assert.ok(!h.writes.some(([name]) => name.endsWith("build-provenance.json")));
});


test("output inside checkout is rejected with Windows case-insensitive path semantics", () => {
  for (const desktopRoot of ["C:\\builds\\desktop", "C:\\BUILDS\\desktop", "C:\\builds\\nightly-20261007-1\\desktop"]) {
    const h = harness({overrides: {desktopRoot}});
    assert.throws(h.build, /outside the source checkout/);
    assert.equal(h.directories.length, 0);
    assert.equal(h.calls.length, 0);
  }
});


test("a different packaged helper cannot publish successful provenance", () => {
  const h = harness({changedHelper: true}); assert.throws(h.build, /Packaged helper differs/);
  assert.ok(!h.writes.some(([name]) => name.endsWith("build-provenance.json")));
});
