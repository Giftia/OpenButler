# OpenButler Desktop Shell

`desktop/` is the Windows Electron shell for OpenButler. It is intentionally thin:

- starts the local FastAPI backend on `127.0.0.1`
- stores OpenButler data under Electron `userData/data`
- runs local mode with strict defaults
- exposes only a small preload bridge to the frontend
- keeps the public Vercel demo separate from real local data

## Development

Build the frontend for Electron first:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\desktop
npm run build:frontend
npm run check:frontend-assets
```

The desktop build uses relative `./assets/...` paths so Electron can load the
bundled `index.html` with `BrowserWindow.loadFile()`. Do not use the normal
Vercel/web `frontend npm run build` output as the desktop package source.

Start the desktop shell:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\desktop
npm install
npm run dev
```

In development, Electron starts the backend with:

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port <free-port>
```

The shell sets:

- `OPENBUTLER_DESKTOP=1`
- `OPENBUTLER_DEFAULT_PRIVACY_MODE=strict`
- `OPENBUTLER_DISABLE_SEED_EVENTS=1`
- `OPENBUTLER_COPY_SCREENSHOTS=0`
- `OPENBUTLER_EXTERNAL_MODEL_ALLOWED=0`
- `OPENBUTLER_EXTERNAL_WEBHOOK_ALLOWED=0`

## Packaging

Build the backend executable:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\backend
python -m pip install -r requirements-desktop.txt
cd ..\desktop
npm run build:backend
```

Build a Windows package:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\desktop
npm run build:frontend
npm run check:frontend-assets
npm run build:backend
npm run pack
npm run smoke:packaged
```

This creates:

- `desktop/dist/win-unpacked/OpenButler.exe` for unpacked local smoke testing.
- `desktop/dist/OpenButler-Setup-0.1.0.exe` for the unsigned Windows installer prototype.

Code signing and auto-update are intentionally out of scope for this first shell.
The Windows builder config disables executable signing/editing for now so local
prototype builds do not require Developer Mode or symlink privileges for the
`winCodeSign` cache.

## Tray Behavior

OpenButler stays available from the Windows tray:

- closing or minimizing the main window hides it instead of stopping the local service
- launching OpenButler again shows the existing window
- the tray menu can reopen the app, restart the local service, open the data folder, or quit

## MineContext And Model Setup

The desktop shell only detects MineContext by default. It does not silently
install MineContext, import real activity, copy screenshots, or call external
models.

The first-run flow lets the user:

- use the sample experience
- check whether MineContext is running locally
- select or start a MineContext installer/app with explicit confirmation
- enter model provider settings
- write model settings to the local MineContext admin API only after clicking confirm

API keys are not returned by `/api/desktop/status`, not shown in diagnostic
summaries, and should never be committed.

## Privacy Boundary

The desktop shell never imports real local data by itself. Selecting a local record
directory only prepares the local-mode setup path. Real import still requires a
separate preview and user confirmation in the OpenButler UI.
