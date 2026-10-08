"""Synthetic API tests; do not open X11 or read any screen pixels."""
import ctypes as C
import importlib.util
import io
from pathlib import Path
import unittest
from PIL import Image

spec = importlib.util.spec_from_file_location('window_source', Path(__file__).parents[1] / 'src/x11-public-window.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeSourceTests(unittest.TestCase):
    def test_unique_active_window(self):
        for values in ([123], [123, 0]):
            self.assertEqual(module.unique_window_property(values), 123)
        for values in ([], [0], [0, 123], [123, 456], [123, 0, 0]):
            with self.assertRaisesRegex(ValueError, 'foreground_unknown'):
                module.unique_window_property(values)

    def fixture(self, wrong_size=False):
        source = module.X11WindowSource.__new__(module.X11WindowSource)
        source.d, source.root = 1, 99
        source.prepared = True
        source.owned_redirect = None
        source.pinned_pixmap = 456
        source.bound_visual = {'visual_id': 33, 'visual_class': 4, 'depth': 24,
                               'red_mask': 0xff0000, 'green_mask': 0xff00, 'blue_mask': 0xff}
        source.selected = {'window_id': 'x11:123', 'content_bounds': {'x': 10, 'y': 20, 'width': 4, 'height': 3}}
        source.inspect = lambda: {'source_identity': source.selected}
        source.sync = lambda: None
        pixels = (C.c_ubyte * 48)(*([30, 20, 10, 0] * 12))
        value = module.XImage(width=4, height=3, format=2, data=C.addressof(pixels), byte_order=0,
                              depth=24, bytes_per_line=16, bits_per_pixel=32,
                              red_mask=0xff0000, green_mask=0xff00, blue_mask=0xff)
        calls = []

        class Xlib:
            def XGetGeometry(self, _display, drawable, root, x, y, w, h, border, depth):
                calls.append(('geometry', drawable))
                w._obj.value, h._obj.value, border._obj.value, depth._obj.value = (5 if wrong_size else 4), 3, 0, 24
                return 1

            def XGetImage(self, _display, drawable, *_args):
                calls.append(('image', drawable))
                return C.pointer(value)

            def XDestroyImage(self, _image):
                calls.append(('destroy',))

            def XFreePixmap(self, _display, pixmap):
                calls.append(('free', pixmap))

            def XSync(self, _display, _discard):
                calls.append(('sync',))

            def XCreateGC(self, _display, drawable, mask, values):
                calls.append(('create_gc', drawable, mask, values))
                return 777

            def XFreeGC(self, _display, gc):
                calls.append(('free_gc', gc))

            def XSetFunction(self, _display, gc, function):
                calls.append(('function', gc, function))

            def XSetPlaneMask(self, _display, gc, mask):
                calls.append(('planes', gc, mask))

            def XSetClipMask(self, _display, gc, mask):
                calls.append(('clip', gc, mask))

            def XSetForeground(self, _display, gc, color):
                calls.append(('foreground', gc, color))

            def XFillRectangle(self, _display, drawable, gc, x, y, w, h):
                calls.append(('fill', drawable, gc, x, y, w, h))
                C.memset(C.addressof(pixels), 0, len(pixels))

            def XSendEvent(self, _display, window, propagate, event_mask, event):
                calls.append(('expose', window, propagate, event_mask, event._obj.window))
                return 1

        class Composite:
            def XCompositeNameWindowPixmap(self, _display, window):
                calls.append(('name', window))
                return 456

            def XCompositeRedirectWindow(self, _display, window, mode):
                calls.append(('redirect', window, mode))

            def XCompositeUnredirectWindow(self, _display, window, mode):
                calls.append(('unredirect', window, mode))

        source.x, source.composite = Xlib(), Composite()
        return source, calls, pixels

    def test_selected_named_pixmap_pixels_and_cleanup(self):
        source, calls, pixels = self.fixture()
        metadata, png = source.acquire()
        with Image.open(io.BytesIO(png)) as image:
            self.assertEqual(image.size, (4, 3))
            self.assertEqual(image.getpixel((2, 1)), (10, 20, 30))
        self.assertEqual(metadata['capture_method'], 'xcomposite_named_window_pixmap')
        self.assertEqual(calls, [('geometry', 456), ('image', 456), ('destroy',)])
        self.assertTrue(all(value == 0 for value in pixels))
        png[:] = b'\0' * len(png)

    def test_wrong_pixmap_bounds_never_read_pixels(self):
        source, calls, _pixels = self.fixture(wrong_size=True)
        with self.assertRaisesRegex(ValueError, 'pixmap_bounds_changed'):
            source.acquire()
        self.assertEqual(calls, [('geometry', 456)])

    def test_prepare_is_exact_clear_sync_expose_and_own_cleanup_without_pixels(self):
        source, calls, _pixels = self.fixture()
        source.prepared = False
        source.pinned_pixmap = None
        source.sync = lambda: calls.append(('sync',))
        self.assertEqual(source.prepare()['pixels_acquired'], False)
        self.assertEqual(source.owned_redirect, 123)
        self.assertTrue(source.prepared)
        self.assertEqual(source.pinned_pixmap, 456)
        self.assertIn(('function', 777, 3), calls)
        self.assertIn(('planes', 777, module.U(-1).value), calls)
        self.assertIn(('clip', 777, 0), calls)
        fill = calls.index(('fill', 456, 777, 0, 0, 4, 3))
        self.assertEqual(calls[fill + 1], ('sync',))
        self.assertIn(('expose', 123, 0, 1 << 15, 123), calls)
        self.assertFalse(any(call[0] == 'image' for call in calls))
        source.release_redirect()
        source.release_redirect()
        self.assertEqual([call for call in calls if call[0] == 'unredirect'], [('unredirect', 123, 0)])
        self.assertIsNone(source.owned_redirect)
        self.assertIsNone(source.pinned_pixmap)
        self.assertFalse(source.prepared)

    def test_clear_failure_releases_own_redirect_without_repaint_or_read(self):
        source, calls, _pixels = self.fixture()
        source.prepared = False
        source.pinned_pixmap = None

        def checked_sync():
            if calls and calls[-1][0] == 'fill':
                raise ValueError('clear_failed')

        source.sync = checked_sync
        with self.assertRaisesRegex(ValueError, 'clear_failed'):
            source.prepare()
        self.assertFalse(source.prepared)
        self.assertIsNone(source.owned_redirect)
        self.assertIn(('unredirect', 123, 0), calls)
        self.assertFalse(any(call[0] in ('image', 'expose') for call in calls))
        with self.assertRaisesRegex(ValueError, 'window_preparation_required'):
            source.acquire()

    def test_identity_loss_after_clear_aborts_before_repaint_and_read(self):
        source, calls, _pixels = self.fixture()
        source.prepared = False
        source.pinned_pixmap = None
        inspections = 0

        def inspect():
            nonlocal inspections
            inspections += 1
            if inspections == 3:
                raise ValueError('window_identity_changed')
            return {'source_identity': source.selected}

        source.inspect = inspect
        with self.assertRaisesRegex(ValueError, 'window_identity_changed'):
            source.prepare()
        self.assertFalse(any(call[0] in ('image', 'expose') for call in calls))
        self.assertEqual([call for call in calls if call[0] == 'unredirect'], [('unredirect', 123, 0)])

    def test_unprepared_source_cannot_read_even_if_a_pixmap_exists(self):
        source, calls, _pixels = self.fixture()
        source.prepared = False
        with self.assertRaisesRegex(ValueError, 'window_preparation_required'):
            source.acquire()
        self.assertEqual(calls, [])

    def test_capture_never_switches_to_new_parent_initialized_backing(self):
        source, calls, _pixels = self.fixture()
        source.prepared = False
        source.pinned_pixmap = None
        source.prepare()
        source.composite.XCompositeNameWindowPixmap = lambda *_args: 789
        metadata, png = source.acquire()
        self.assertEqual([call[1] for call in calls if call[0] == 'fill'], [456])
        self.assertEqual([call[1] for call in calls if call[0] == 'image'], [456])
        self.assertFalse(metadata['content_nonblack'])
        png[:] = b'\0' * len(png)
        source.release_redirect()

    def test_pixmap_zero_masks_require_exact_authoritative_truecolor_visual(self):
        source, _calls, pixels = self.fixture()
        value = module.XImage(width=4, height=3, format=2, data=C.addressof(pixels),
                              byte_order=0, depth=24, bytes_per_line=16, bits_per_pixel=32)
        self.assertTrue(module.valid_pixel_format(value, source.bound_visual, 4, 3))
        self.assertFalse(module.valid_pixel_format(value, None, 4, 3))
        self.assertFalse(module.valid_pixel_format(value, {**source.bound_visual, 'visual_class': 5}, 4, 3))
        self.assertFalse(module.valid_pixel_format(value, {**source.bound_visual, 'red_mask': 0xff}, 4, 3))
        for field, invalid in [('red_mask', 0xff0000), ('blue_mask', 0xff0000),
                               ('format', 1), ('xoffset', 1), ('byte_order', 1),
                               ('bits_per_pixel', 24), ('bytes_per_line', 20), ('depth', 32)]:
            old = getattr(value, field)
            setattr(value, field, invalid)
            self.assertFalse(module.valid_pixel_format(value, source.bound_visual, 4, 3), field)
            setattr(value, field, old)
        value.red_mask, value.green_mask, value.blue_mask = 0xff0000, 0xff00, 0xff
        self.assertTrue(module.valid_pixel_format(value, source.bound_visual, 4, 3))


class IdentityDiagnosticTests(unittest.TestCase):
    def fixture(self, kinds):
        source, calls, _pixels = NativeSourceTests().fixture()
        del source.inspect
        source.invalid, source.identity_atoms = None, {101}
        events = []
        for kind in kinds:
            event = (C.c_long * 24)()
            C.cast(C.byref(event), C.POINTER(module.I))[0] = kind
            event[5] = 101
            if kind == 22:
                value = C.cast(C.byref(event), C.POINTER(module.ConfigureEvent)).contents
                value.width, value.height, value.border_width = 5, 3, 0
            events.append(event)

        def next_event(_display, target):
            event = events.pop(0)
            C.memmove(target, C.byref(event), C.sizeof(event))

        source.x.XPending = lambda _display: len(events)
        source.x.XNextEvent = next_event
        source.identity = lambda _window: source.selected
        source.visual_info = lambda _window: source.bound_visual
        source.foreground = lambda: source.selected
        return source, calls

    def test_single_or_repeated_property_events_still_stop_without_claiming_change(self):
        for kinds in ([28], [28, 28]):
            with self.subTest(kinds=kinds):
                source, calls = self.fixture(kinds)
                with self.assertRaisesRegex(ValueError, 'window_identity_unverified'):
                    source.acquire()
                self.assertFalse(any(call[0] == 'image' for call in calls))
                self.assertEqual(source.invalid, 'window_identity_unverified')

    def test_lifecycle_events_keep_stronger_diagnosis_in_either_event_order(self):
        for kind in (17, 18, 21, 22):
            for kinds in ([kind, 28], [28, kind]):
                with self.subTest(kinds=kinds):
                    source, calls = self.fixture(kinds)
                    with self.assertRaisesRegex(ValueError, 'window_destroyed_unmapped_or_reconfigured'):
                        source.acquire()
                    self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_observed_identity_mismatch_retains_changed_diagnosis(self):
        source, calls = self.fixture([])
        source.identity = lambda _window: {**source.selected, 'owner_process_start': 'different'}
        with self.assertRaisesRegex(ValueError, 'window_identity_changed'):
            source.acquire()
        self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_property_event_with_observed_mismatch_reports_changed_before_pixels(self):
        for field in ('window_title', 'owner_pid', 'wm_class'):
            for kinds in ([28], [28, 28]):
                for predrain in (False, True):
                    with self.subTest(field=field, kinds=kinds, predrain=predrain):
                        source, calls = self.fixture(kinds)
                        source.identity = lambda _window: {**source.selected, field: 'different'}
                        if predrain:
                            source.drain()  # The idle main loop drains before commands.
                        with self.assertRaisesRegex(ValueError, '^window_identity_changed$'):
                            source.acquire()
                        self.assertEqual(source.invalid, 'window_identity_changed')
                        self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_property_event_with_visual_mismatch_reports_changed_before_pixels(self):
        source, calls = self.fixture([28])
        source.visual_info = lambda _window: {**source.bound_visual, 'visual_id': 44}
        with self.assertRaisesRegex(ValueError, '^window_identity_changed$'):
            source.acquire()
        self.assertEqual(source.invalid, 'window_identity_changed')
        self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_restored_values_after_notifications_never_restore_capture(self):
        source, calls = self.fixture([28, 28])
        source.drain()
        for _attempt in range(2):
            with self.assertRaisesRegex(ValueError, '^window_identity_unverified$'):
                source.acquire()
            self.assertEqual(source.invalid, 'window_identity_unverified')
        self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_metadata_failure_preserves_failure_and_property_latch(self):
        for method, reason in (('identity', 'window_identity_unavailable'),
                               ('visual_info', 'window_visual_unavailable')):
            with self.subTest(method=method):
                source, calls = self.fixture([28])
                original = getattr(source, method)

                def fail(_window):
                    raise ValueError(reason)

                setattr(source, method, fail)
                with self.assertRaisesRegex(ValueError, '^' + reason + '$'):
                    source.acquire()
                self.assertEqual(source.invalid, 'window_identity_unverified')
                setattr(source, method, original)
                with self.assertRaisesRegex(ValueError, '^window_identity_unverified$'):
                    source.acquire()
                self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_lifecycle_during_metadata_read_retains_priority(self):
        for kind in (17, 18, 21, 22):
            source, calls = self.fixture([28])
            pending = []
            original_pending = source.x.XPending
            original_next = source.x.XNextEvent
            source.x.XPending = lambda display: original_pending(display) or len(pending)

            def next_event(display, target):
                if original_pending(display):
                    return original_next(display, target)
                event = pending.pop(0)
                C.memmove(target, C.byref(event), C.sizeof(event))

            def identity(_window):
                if kind == 22:
                    event = module.ConfigureEvent(type=22, width=5, height=3, border_width=0)
                else:
                    event = (C.c_long * 24)()
                    C.cast(C.byref(event), C.POINTER(module.I))[0] = kind
                pending.append(event)
                return {**source.selected, 'window_title': 'different'}

            source.x.XNextEvent = next_event
            source.identity = identity
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, '^window_destroyed_unmapped_or_reconfigured$'):
                    source.acquire()
                self.assertFalse(any(call[0] == 'image' for call in calls))

    def test_property_event_cannot_downgrade_an_existing_observed_mismatch(self):
        source, _calls = self.fixture([28])
        source.invalid = 'window_identity_changed'
        source.drain()
        self.assertEqual(source.invalid, 'window_identity_changed')


if __name__ == '__main__':
    unittest.main()
