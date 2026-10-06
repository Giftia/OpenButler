#!/usr/bin/env python3
"""OpenButler source-bound X11 client-window acquisition.

Only XCompositeNameWindowPixmap(selected client) is readable. There is no root
image, screen thumbnail, screenshot-file or network path. Explicit preparation
redirects only that client in Automatic mode and clears its complete named pixmap
before any pixel read. A persistent X connection tracks destruction,
unmapping and geometry changes, including an XID being reused between frames.
The stdout protocol is a JSON header followed by exactly raw_bytes PNG bytes.
"""
import ctypes as C
import io
import json
import os
import select
import signal
import sys
import time
from pathlib import Path

from PIL import Image

U = C.c_ulong
I = C.c_int
P = C.c_void_p


class Attributes(C.Structure):
    _fields_ = [(n, t) for n, t in [
        ('x', I), ('y', I), ('width', I), ('height', I), ('border_width', I), ('depth', I),
        ('visual', P), ('root', U), ('window_class', I), ('bit_gravity', I), ('win_gravity', I),
        ('backing_store', I), ('backing_planes', U), ('backing_pixel', U), ('save_under', I),
        ('colormap', U), ('map_installed', I), ('map_state', I), ('all_event_masks', C.c_long),
        ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long),
        ('override_redirect', I), ('screen', P)]]


class Visual(C.Structure):
    _fields_ = [('ext_data', P), ('visual_id', U), ('visual_class', I),
                ('red_mask', U), ('green_mask', U), ('blue_mask', U),
                ('bits_per_rgb', I), ('map_entries', I)]


class XImage(C.Structure):
    _fields_ = [(n, t) for n, t in [
        ('width', I), ('height', I), ('xoffset', I), ('format', I), ('data', P),
        ('byte_order', I), ('bitmap_unit', I), ('bitmap_bit_order', I), ('bitmap_pad', I),
        ('depth', I), ('bytes_per_line', I), ('bits_per_pixel', I),
        ('red_mask', U), ('green_mask', U), ('blue_mask', U), ('obdata', P),
        ('functions', P * 6)]]


class XError(C.Structure):
    _fields_ = [('type', I), ('display', P), ('resourceid', U), ('serial', U),
                ('error_code', C.c_ubyte), ('request_code', C.c_ubyte), ('minor_code', C.c_ubyte)]


class ConfigureEvent(C.Structure):
    _fields_ = [('type', I), ('serial', U), ('send_event', I), ('display', P),
                ('event', U), ('window', U), ('x', I), ('y', I), ('width', I),
                ('height', I), ('border_width', I), ('above', U), ('override_redirect', I)]


class ExposeEvent(C.Structure):
    _fields_ = [('type', I), ('serial', U), ('send_event', I), ('display', P),
                ('window', U), ('x', I), ('y', I), ('width', I), ('height', I), ('count', I)]


class X11WindowSource:
    def __init__(self):
        if not os.environ.get('DISPLAY') or os.environ.get('XDG_SESSION_TYPE') == 'wayland':
            raise ValueError('x11_display_unavailable')
        self.x = C.CDLL('libX11.so.6')
        self.composite = C.CDLL('libXcomposite.so.1')
        definitions = {
            'XOpenDisplay': ([C.c_char_p], P), 'XCloseDisplay': ([P], I),
            'XDefaultRootWindow': ([P], U), 'XInternAtom': ([P, C.c_char_p, I], U),
            'XGetWindowProperty': ([P, U, U, C.c_long, C.c_long, I, U,
                                   C.POINTER(U), C.POINTER(I), C.POINTER(U),
                                   C.POINTER(U), C.POINTER(P)], I),
            'XGetWindowAttributes': ([P, U, C.POINTER(Attributes)], I),
            'XTranslateCoordinates': ([P, U, U, I, I, C.POINTER(I), C.POINTER(I), C.POINTER(U)], I),
            'XSelectInput': ([P, U, C.c_long], I), 'XSync': ([P, I], I),
            'XPending': ([P], I), 'XNextEvent': ([P, P], I), 'XFree': ([P], I),
            'XFreePixmap': ([P, U], I),
            'XGetGeometry': ([P, U, C.POINTER(U), C.POINTER(I), C.POINTER(I),
                             C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint),
                             C.POINTER(C.c_uint)], I),
            'XGetImage': ([P, U, I, I, C.c_uint, C.c_uint, U, I], C.POINTER(XImage)),
            'XDestroyImage': ([C.POINTER(XImage)], I),
            'XCreateGC': ([P, U, U, P], P), 'XFreeGC': ([P, P], I),
            'XSetFunction': ([P, P, I], I), 'XSetPlaneMask': ([P, P, U], I),
            'XSetClipMask': ([P, P, U], I), 'XSetForeground': ([P, P, U], I),
            'XFillRectangle': ([P, U, P, I, I, C.c_uint, C.c_uint], I),
            'XSendEvent': ([P, U, I, C.c_long, P], I),
        }
        for name, (args, result) in definitions.items():
            getattr(self.x, name).argtypes = args
            getattr(self.x, name).restype = result
        self.composite.XCompositeQueryVersion.argtypes = [P, C.POINTER(I), C.POINTER(I)]
        self.composite.XCompositeNameWindowPixmap.argtypes = [P, U]
        self.composite.XCompositeNameWindowPixmap.restype = U
        self.composite.XCompositeRedirectWindow.argtypes = [P, U, I]
        self.composite.XCompositeUnredirectWindow.argtypes = [P, U, I]
        self.error = None
        self.error_handler = C.CFUNCTYPE(I, P, C.POINTER(XError))(self.on_error)
        self.x.XSetErrorHandler.argtypes = [P]
        self.x.XSetErrorHandler(self.error_handler)
        self.d = self.x.XOpenDisplay(None)
        if not self.d:
            raise ValueError('x11_display_unavailable')
        self.root = self.x.XDefaultRootWindow(self.d)
        major, minor = I(), I()
        if not self.composite.XCompositeQueryVersion(self.d, C.byref(major), C.byref(minor)) \
                or (major.value, minor.value) < (0, 2):
            raise ValueError('xcomposite_unavailable')
        self.selected = None
        self.invalid = None
        self.owned_redirect = None
        self.pinned_pixmap = None
        self.bound_visual = None
        self.last_format_metadata = None
        self.prepared = False
        self.identity_atoms = {self.x.XInternAtom(self.d, name, 0) for name in
                               (b'_NET_WM_NAME', b'_NET_WM_PID', b'WM_CLASS')}

    def on_error(self, _display, error):
        self.error = int(error.contents.error_code)
        return 0

    def sync(self):
        self.x.XSync(self.d, 0)
        if self.error is not None:
            self.error = None
            raise ValueError('window_source_unavailable')

    def prop(self, window, name, fmt):
        atom = self.x.XInternAtom(self.d, name.encode(), 1)
        if not atom:
            raise ValueError('window_identity_unavailable')
        actual, form, count, remaining, data = U(), I(), U(), U(), P()
        status = self.x.XGetWindowProperty(self.d, window, atom, 0, 4096, 0, 0,
                                          C.byref(actual), C.byref(form), C.byref(count),
                                          C.byref(remaining), C.byref(data))
        try:
            self.sync()
            if status or form.value != fmt or remaining.value or not data.value:
                raise ValueError('window_identity_unavailable')
            if fmt == 32:
                return list(C.cast(data, C.POINTER(U))[:count.value])
            return C.string_at(data, count.value)
        finally:
            if data.value:
                self.x.XFree(data)

    def clients(self):
        clients = self.prop(self.root, '_NET_CLIENT_LIST', 32)
        if len(clients) > 200:
            raise ValueError('window_list_unavailable')
        return clients

    def identity(self, window, require_opaque=True):
        if window == self.root or window not in self.clients():
            raise ValueError('client_window_required')
        attr = Attributes()
        if not self.x.XGetWindowAttributes(self.d, window, C.byref(attr)):
            raise ValueError('window_source_unavailable')
        self.sync()
        if attr.map_state != 2 or attr.override_redirect \
                or (require_opaque and (attr.depth != 24 or attr.border_width != 0)) \
                or attr.width < 1 or attr.height < 1 \
                or attr.width * attr.height > 16_000_000:
            raise ValueError('opaque_visible_client_required')
        x, y, child = I(), I(), U()
        if not self.x.XTranslateCoordinates(self.d, window, self.root, 0, 0,
                                            C.byref(x), C.byref(y), C.byref(child)):
            raise ValueError('window_bounds_unavailable')
        self.sync()
        if x.value < 0 or y.value < 0:
            raise ValueError('window_bounds_unavailable')
        pid_values = self.prop(window, '_NET_WM_PID', 32)
        if len(pid_values) != 1 or not 1 <= pid_values[0] <= 2 ** 31:
            raise ValueError('window_identity_unavailable')
        pid = pid_values[0]
        proc = Path('/proc') / str(pid)
        if proc.stat().st_uid != os.getuid():
            raise ValueError('window_owner_unavailable')
        process_start = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()[19]
        process_name = Path(os.readlink(proc / 'exe')).name
        title = self.prop(window, '_NET_WM_NAME', 8).decode('utf-8', errors='strict')
        wm_class = self.prop(window, 'WM_CLASS', 8).replace(b'\x00', b':').rstrip(b':').decode('utf-8')
        if not title or len(title) > 240 or not wm_class or len(wm_class) > 240 \
                or len(process_name) > 120 or any(ord(c) < 32 or ord(c) == 127
                                                for c in title + wm_class + process_name):
            raise ValueError('window_identity_unavailable')
        return {'window_id': f'x11:{window}', 'owner_pid': pid,
                'owner_process_start': process_start, 'owner_process_name': process_name,
                'wm_class': wm_class, 'window_title': title,
                'content_bounds': {'x': x.value, 'y': y.value, 'width': attr.width, 'height': attr.height}}

    def foreground(self):
        values = self.prop(self.root, '_NET_ACTIVE_WINDOW', 32)
        window = unique_window_property(values)
        # Foreground identity is metadata only. No pixels are read from it.
        return self.identity(window, require_opaque=False)

    def visual_info(self, window):
        attr = Attributes()
        if not self.x.XGetWindowAttributes(self.d, window, C.byref(attr)):
            raise ValueError('window_visual_unavailable')
        self.sync()
        if not attr.visual or attr.depth != 24:
            raise ValueError('unsupported_window_visual')
        visual = C.cast(attr.visual, C.POINTER(Visual)).contents
        info = {key: int(getattr(visual, key)) for key in
                ('visual_id', 'visual_class', 'red_mask', 'green_mask', 'blue_mask')}
        info['depth'] = attr.depth
        if not valid_visual(info):
            raise ValueError('unsupported_window_visual')
        return info

    def drain(self):
        while self.x.XPending(self.d):
            event = (C.c_long * 24)()
            self.x.XNextEvent(self.d, C.byref(event))
            kind = C.cast(C.byref(event), C.POINTER(I))[0]
            if self.selected and kind in (17, 18, 21):
                self.invalid = 'window_destroyed_unmapped_or_reconfigured'
            if self.selected and kind == 22:
                value = C.cast(C.byref(event), C.POINTER(ConfigureEvent)).contents
                bounds = self.selected['content_bounds']
                # Stacking-only notifications do not change the source. Synthetic
                # WM notifications carry root coordinates; real events can carry
                # frame-relative coordinates, which are rechecked by inspect().
                if (value.width, value.height, value.border_width) != (bounds['width'], bounds['height'], 0) \
                        or (value.send_event and (value.x, value.y) != (bounds['x'], bounds['y'])):
                    self.invalid = 'window_destroyed_unmapped_or_reconfigured'
            if self.selected and kind == 28 and event[5] in self.identity_atoms:
                self.invalid = 'window_identity_changed'
        self.sync()

    def inspect(self):
        self.drain()
        if not self.selected or self.invalid:
            raise ValueError(self.invalid or 'window_selection_required')
        identity = self.identity(int(self.selected['window_id'].split(':')[1]))
        visual = self.visual_info(int(self.selected['window_id'].split(':')[1]))
        if identity != self.selected or visual != self.bound_visual:
            self.invalid = 'window_identity_changed'
            raise ValueError(self.invalid)
        return {'source_identity': identity, 'foreground_identity': self.foreground(),
                'lock_state': 'unknown', 'lock_protection_supported': False,
                'observed_at_ms': int(time.time() * 1000)}

    def bind(self, identity):
        if self.selected == identity and self.prepared and not self.invalid:
            return self.inspect()
        self.release_redirect()
        if self.selected:
            self.x.XSelectInput(self.d, int(self.selected['window_id'].split(':')[1]), 0)
        self.selected, self.invalid = None, None
        self.drain()
        window = int(identity['window_id'].split(':')[1])
        # Select before identity inspection so destroy/reuse races leave an event.
        self.x.XSelectInput(self.d, window, (1 << 17) | (1 << 22))
        self.sync()
        actual = self.identity(window)
        if actual != identity:
            raise ValueError('window_identity_changed')
        self.selected = actual
        self.bound_visual = self.visual_info(window)
        return self.inspect()

    def release_redirect(self):
        pixmap = self.pinned_pixmap
        self.pinned_pixmap = None
        window = self.owned_redirect
        self.owned_redirect = None
        self.prepared = False
        if pixmap is not None:
            self.x.XFreePixmap(self.d, pixmap)
        if window is not None:
            # Same connection, same exact window, same Automatic mode only.
            # Never remove another client's redirect or any subtree/root setting.
            self.composite.XCompositeUnredirectWindow(self.d, window, 0)
            self.x.XSync(self.d, 0)
            self.error = None  # Destruction may already have removed this resource.

    def checked_pixmap(self):
        window = int(self.selected['window_id'].split(':')[1])
        pixmap = self.composite.XCompositeNameWindowPixmap(self.d, window)
        try:
            self.sync()
            if not pixmap or pixmap in (window, self.root):
                raise ValueError('isolated_pixmap_unavailable')
            width, height = self.validate_pixmap(pixmap)
            return pixmap, width, height
        except Exception:
            if pixmap:
                self.x.XFreePixmap(self.d, pixmap)
            raise

    def validate_pixmap(self, pixmap):
        root, x, y = U(), I(), I()
        w, h, border, depth = C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
        if not self.x.XGetGeometry(self.d, pixmap, C.byref(root), C.byref(x), C.byref(y),
                                  C.byref(w), C.byref(h), C.byref(border), C.byref(depth)):
            raise ValueError('isolated_pixmap_unavailable')
        self.sync()
        bounds = self.selected['content_bounds']
        if (w.value, h.value, border.value, depth.value) != (bounds['width'], bounds['height'], 0, 24):
            raise ValueError('pixmap_bounds_changed')
        return w.value, h.value

    def prepare(self):
        self.inspect()
        if self.prepared:
            return {'prepared': True, 'pixels_acquired': False, 'repaint_requested': True}
        window = int(self.selected['window_id'].split(':')[1])
        pixmap, gc = 0, None
        try:
            # CompositeRedirectAutomatic = 0. Explicit preview only, never list/bind.
            self.owned_redirect = window
            self.composite.XCompositeRedirectWindow(self.d, window, 0)
            self.sync()
            self.inspect()
            pixmap, width, height = self.checked_pixmap()
            gc = self.x.XCreateGC(self.d, pixmap, 0, None)
            self.sync()
            if not gc:
                raise ValueError('window_initialization_failed')
            self.x.XSetFunction(self.d, gc, 3)  # GXcopy
            self.x.XSetPlaneMask(self.d, gc, U(-1).value)
            self.x.XSetClipMask(self.d, gc, 0)  # None, whole named pixmap
            self.x.XSetForeground(self.d, gc, 0)
            self.x.XFillRectangle(self.d, pixmap, gc, 0, 0, width, height)
            self.sync()  # Failed clear must never reach any XGetImage.
            self.inspect()
            event = ExposeEvent(type=12, send_event=1, display=self.d, window=window,
                                x=0, y=0, width=width, height=height, count=0)
            # A client repaint request only. XClearArea is intentionally not used:
            # ParentRelative backgrounds could reintroduce inherited parent pixels.
            if not self.x.XSendEvent(self.d, window, 0, 1 << 15, C.byref(event)):
                raise ValueError('window_repaint_unavailable')
            self.sync()
            self.inspect()
            # Pin this exact, successfully cleared backing. Never name a fresh
            # (possibly parent-initialized) backing during later frame reads.
            self.pinned_pixmap = pixmap
            pixmap = 0
            self.prepared = True
            return {'prepared': True, 'pixels_acquired': False, 'repaint_requested': True}
        except Exception:
            self.release_redirect()
            self.invalid = 'window_initialization_failed'
            raise
        finally:
            if gc:
                self.x.XFreeGC(self.d, gc)
            if pixmap:
                self.x.XFreePixmap(self.d, pixmap)

    def acquire(self):
        if not self.prepared or self.pinned_pixmap is None:
            raise ValueError('window_preparation_required')
        before = self.inspect()
        pixmap, image = 0, None
        raw_pixels, png = None, None
        try:
            # The only image drawable ever read is the selected named pixmap,
            # after explicit, successfully cleared source initialization.
            pixmap = self.pinned_pixmap
            width, height = self.validate_pixmap(pixmap)
            captured_at_ms = int(time.time() * 1000)
            image = self.x.XGetImage(self.d, pixmap, 0, 0, width, height, U(-1).value, 2)
            self.sync()
            if not image:
                raise ValueError('isolated_pixmap_unavailable')
            value = image.contents
            self.last_format_metadata = {key: int(getattr(value, key)) for key in
                ('depth', 'bits_per_pixel', 'byte_order', 'format', 'xoffset',
                 'bytes_per_line', 'red_mask', 'green_mask', 'blue_mask')}
            self.last_format_metadata.update({f'visual_{key}': val for key, val in self.bound_visual.items()})
            if not valid_pixel_format(value, self.bound_visual, width, height):
                raise ValueError('unsupported_window_pixel_format')
            raw_pixels = bytearray((C.c_ubyte * (value.bytes_per_line * value.height)).from_address(value.data))
            picture = Image.frombytes('RGB', (value.width, value.height), raw_pixels,
                                      'raw', 'BGRX', value.bytes_per_line, 1)
            content_nonblack = picture.getbbox() is not None
            output = io.BytesIO()
            picture.save(output, format='PNG')
            picture.paste((0, 0, 0), (0, 0, value.width, value.height))
            picture.close()
            view = output.getbuffer()
            png = bytearray(view)
            view[:] = b'\0' * len(view)
            view.release()
            output.close()
            after = self.inspect()
            if before['source_identity'] != after['source_identity']:
                raise ValueError('window_identity_changed')
            return {'source_identity': after['source_identity'], 'captured_at_ms': captured_at_ms,
                    'source_verified_before': True, 'source_verified_after': True,
                    'capture_method': 'xcomposite_named_window_pixmap', 'raw_bytes': len(png),
                    'content_nonblack': content_nonblack, 'format_metadata': self.last_format_metadata}, png
        except Exception:
            if png is not None:
                png[:] = b'\0' * len(png)
            raise
        finally:
            if raw_pixels is not None:
                raw_pixels[:] = b'\0' * len(raw_pixels)
            if image:
                value = image.contents
                if value.data and 0 < value.bytes_per_line * value.height <= 64_000_000:
                    C.memset(value.data, 0, value.bytes_per_line * value.height)
                self.x.XDestroyImage(image)
            # The cleared backing remains pinned until source/session release.

    def command(self, request):
        action = request.get('action')
        if action == 'list':
            sources = []
            for window in self.clients():
                try:
                    sources.append(self.identity(window))
                except (ValueError, OSError, UnicodeError):
                    pass
            return {'sources': sources, 'lock_state': 'unknown'}, None
        if action == 'bind':
            return self.bind(request['source_identity']), None
        if action == 'inspect':
            return self.inspect(), None
        if action == 'prepare':
            return self.prepare(), None
        if action == 'capture':
            return self.acquire()
        raise ValueError('unsupported_source_command')


def main():
    source = X11WindowSource()
    try:
        while True:
            source.drain()
            ready, _, _ = select.select([sys.stdin], [], [], 0.1)
            if not ready:
                continue
            line = sys.stdin.readline(16000)
            if not line:
                break
            png = None
            try:
                request = json.loads(line)
                result, png = source.command(request)
                response = {'ok': True, **result}
            except Exception as error:
                # No source title, pixels, paths or exception detail in errors.
                code = str(error) if isinstance(error, ValueError) else 'window_source_unavailable'
                if not code.replace('_', '').isalnum():
                    code = 'window_source_unavailable'
                response = {'ok': False, 'error': code, 'raw_bytes': 0}
                if code == 'unsupported_window_pixel_format':
                    response['format_metadata'] = source.last_format_metadata
            sys.stdout.buffer.write(json.dumps(response).encode() + b'\n')
            if png is not None:
                sys.stdout.buffer.write(png)
                png[:] = b'\0' * len(png)
            sys.stdout.buffer.flush()
    finally:
        source.release_redirect()
        source.x.XCloseDisplay(source.d)


def unique_window_property(values):
    # Some observed X11 desktops append a zero word. Never choose arbitrarily
    # between two nonzero IDs or accept a leading zero / unbounded property.
    if not values or len(values) > 2 or not values[0] or any(values[1:]):
        raise ValueError('foreground_unknown')
    return values[0]


def valid_visual(visual):
    return visual and visual.get('depth') == 24 and visual.get('visual_id', 0) > 0 \
        and visual.get('visual_class') == 4 and (visual.get('red_mask'), visual.get('green_mask'),
        visual.get('blue_mask')) == (0xff0000, 0xff00, 0xff)


def valid_pixel_format(image, visual, width, height):
    # X11 GetImage returns Visual=None for a Pixmap. Xlib can therefore leave
    # all three image masks zero. Color authority is the exact bound window's
    # independently verified TrueColor Visual, never a guessed default visual.
    masks = (image.red_mask, image.green_mask, image.blue_mask)
    return bool(valid_visual(visual) and image.data
                and (image.width, image.height, image.depth, image.bits_per_pixel,
                     image.byte_order, image.format, image.xoffset, image.bytes_per_line) ==
                (width, height, 24, 32, 0, 2, 0, width * 4)
                and width * 4 * height <= 64_000_000
                and masks in ((0, 0, 0), (0xff0000, 0xff00, 0xff)))


if __name__ == '__main__':
    def terminate(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'error': 'window_source_unavailable', 'raw_bytes': 0}), flush=True)
        sys.exit(1)
