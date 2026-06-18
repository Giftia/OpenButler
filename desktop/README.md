# OpenButler Desktop Shell

`desktop/` is the Windows Electron shell for OpenButler. It is intentionally thin:

- starts the local FastAPI backend on `127.0.0.1`
- stores OpenButler data under Electron `userData/data`
- runs local mode with strict defaults
- exposes only a small preload bridge to the frontend
- keeps the public Vercel demo separate from real local data

## Development

Build the frontend first:

```powershell
cd C:\Users\admin\Desktop\git\OpenButler\frontend
npm run build
```

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
npm run dist
```

Code signing and auto-update are intentionally out of scope for this first shell.

## Privacy Boundary

The desktop shell never imports real local data by itself. Selecting a local record
directory only prepares the local-mode setup path. Real import still requires a
separate preview and user confirmation in the OpenButler UI.
