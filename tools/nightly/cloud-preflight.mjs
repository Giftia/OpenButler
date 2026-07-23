import {spawnSync} from "node:child_process";
import {resolveCodexCommand} from "./nightly-lib.mjs";

const environmentId = process.env.OPENBUTLER_CODEX_CLOUD_ENV_ID?.trim();
const codex = resolveCodexCommand();
const list = spawnSync(codex.command, [...codex.argsPrefix, "cloud", "list", "--json", "--limit", "1"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});

const result = {
  authenticated: list.status === 0,
  environment_configured: Boolean(environmentId),
  maker_enabled: list.status === 0 && Boolean(environmentId),
  fallback: "defer_code_to_local_nightly",
  error_code: list.error?.code ?? null,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.maker_enabled ? 0 : 2);
