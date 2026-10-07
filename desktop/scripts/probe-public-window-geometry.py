#!/usr/bin/env python3
"""Geometry only; optional explicit --prepare tests approved UI initialization.

No XGetImage, OCR or file output. --prepare may briefly blacken the selected
public client; it releases this connection's own redirect before exit.
"""
import ctypes as C
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('window_source', Path(__file__).parents[1] / 'src/x11-public-window.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source, pixmap = None, 0
stage = 'arguments'
try:
    if len(sys.argv) not in (2, 3) or not sys.argv[1].isdigit() \
            or (len(sys.argv) == 3 and sys.argv[2] != '--prepare'):
        raise ValueError('numeric_selected_xid_required')
    stage = 'x11_connect'
    source = module.X11WindowSource()
    stage = 'source_identity'
    identity = source.identity(int(sys.argv[1]))
    stage = 'bind_and_foreground'
    source.bind(identity)
    prepared = len(sys.argv) == 3
    if prepared:
        stage = 'selected_client_initialize_no_pixels'
        source.prepare()
    stage = 'named_window_pixmap'
    pixmap = source.composite.XCompositeNameWindowPixmap(source.d, int(sys.argv[1]))
    source.x.XSync(source.d, 0)
    if source.error is not None:
        code = source.error
        source.error = None
        raise ValueError('xcomposite_bad_match' if code == 8 else 'xcomposite_source_unavailable')
    if not pixmap or pixmap == source.root or pixmap == int(sys.argv[1]):
        raise ValueError('isolated_pixmap_unavailable')
    stage = 'pixmap_geometry'
    root, x, y = module.U(), module.I(), module.I()
    w, h, border, depth = C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
    if not source.x.XGetGeometry(source.d, pixmap, C.byref(root), C.byref(x), C.byref(y),
                                C.byref(w), C.byref(h), C.byref(border), C.byref(depth)):
        raise ValueError('pixmap_geometry_unavailable')
    source.sync()
    stage = 'identity_recheck'
    source.inspect()
    print(json.dumps({'ok': True, 'stage': 'geometry_only_complete', 'pixels_acquired': False,
                      'window_id': identity['window_id'], 'width': w.value, 'height': h.value,
                      'border': border.value, 'depth': depth.value,
                      'prepared_and_cleared': prepared,
                      'client_bounds_match': (w.value, h.value, border.value, depth.value) ==
                      (identity['content_bounds']['width'], identity['content_bounds']['height'], 0, 24),
                      'lock_state': 'unknown'}))
except Exception as error:
    code = str(error) if isinstance(error, ValueError) else 'probe_unavailable'
    if not code.replace('_', '').isalnum():
        code = 'probe_unavailable'
    print(json.dumps({'ok': False, 'stage': stage, 'error_code': code, 'pixels_acquired': False}))
    sys.exit(1)
finally:
    if source:
        if pixmap:
            source.x.XFreePixmap(source.d, pixmap)
        source.release_redirect()
        source.x.XCloseDisplay(source.d)
