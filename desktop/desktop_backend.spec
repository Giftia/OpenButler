# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path


repo_root = Path(__file__).resolve().parents[1]
backend_dir = repo_root / "backend"

a = Analysis(
    ["backend_entry.py"],
    pathex=[str(backend_dir), str(repo_root / "desktop")],
    binaries=[],
    datas=[],
    hiddenimports=[
        "app.main",
        "app.modules.butler_core.router",
        "app.modules.pc_activity_context.router",
        "app.modules.workstation_vision.router",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="openbutler-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
