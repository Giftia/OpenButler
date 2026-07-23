import {spawnSync} from "node:child_process";

const environmentId = process.env.OPENBUTLER_CODEX_CLOUD_ENV_ID?.trim();
const list = spawnSync("codex", ["cloud", "list", "--json", "--limit", "1"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});

const result = {
  authenticated: list.status === 0,
  environment_configured: Boolean(environmentId),
  maker_enabled: list.status === 0 && Boolean(environmentId),
  fallback: "defer_code_to_local_nightly",
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.maker_enabled ? 0 : 2);
