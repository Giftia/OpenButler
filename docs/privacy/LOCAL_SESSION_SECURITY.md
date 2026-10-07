# Local Session Security

## Modes

Local API calls require `X-OpenButler-Session`, a process-scoped 32-byte random
token encoded as 64 hexadecimal characters. GET/HEAD `/health` remains public.
Missing server configuration returns 503; a missing/invalid credential returns
401. Invalid Origin, non-loopback peer, untrusted Host or duplicate security
headers return 403 before request-time initialization or route execution.

Local browser Origins are explicit localhost/127.0.0.1 ports 5173 and 5175.
`OPENBUTLER_ALLOWED_ORIGINS` may replace these with explicit loopback Origins.
Opaque `null` Origins are rejected, including file pages. Electron instead uses
a main-frame-validated IPC proxy: the main process holds the token and injects
the header, never giving the token to the page, URLs, runtime status or storage.
Restart rotates the backend credential and the proxy uses the new API address.

Hosted Vercel mode permits only a fixed list of synthetic product reads. Local
sources, model settings, diagnostics and writes are unavailable in that mode.
This is not an authentication service for remote or multi-user installations.

## Local browser development

Use one temporary token in both backend and Vite process environments. Do not
put it in a VITE-prefixed variable, `.env`, browser storage or command arguments.
Set `OPENBUTLER_API_BASE_URL` to the loopback backend; leave
`VITE_API_BASE_URL` unset so requests use the same-origin Vite proxy. Bind Vite
and the backend to loopback only; do not forward these developer ports remotely.
The Vite server injects the credential in memory, not in the frontend build.
Authenticated development requests are accepted only from a loopback socket
with a loopback Host and a matching Origin when present. Vite preview binds to
loopback and disables the authenticated API proxy entirely.

Example authenticated request (PowerShell, existing environment token):

```powershell
Invoke-RestMethod http://127.0.0.1:8010/api/events -Headers @{
  'X-OpenButler-Session' = $env:OPENBUTLER_SESSION_TOKEN
}
```

The desktop launcher supplies this environment automatically. Standalone local
startup without a credential deliberately leaves protected routes unavailable.

## Boundary

Session authentication protects against unrelated local websites and accidental
LAN exposure. It does not defend against malware already running as the same OS
user. PrivacyGuard still decides which authenticated operations are permitted.
Do not infer capture/model/installation verification from these HTTP checks.

## Local privacy activity

`GET /api/context-engine/status` reports capability metadata only. It currently
reports capture and model routing as unavailable. `GET /api/privacy/activity`
returns a bounded local ledger containing only the action category, allow/deny,
reason code, privacy mode and UTC timestamp. Both require the desktop session.
The ledger retains at most seven days and 10,000 rows in the OpenButler database;
it has no activity title, screenshot, source path, model key or payload field.
An audit write failure denies the operation. The explicit local deletion method
removes only this ledger. These contracts do not enable recording or models.
