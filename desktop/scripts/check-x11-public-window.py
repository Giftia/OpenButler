"""Synthetic API tests; do not open X11 or read any screen pixels."""
import ctypes as C
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
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

    def test_destroy_unmap_reparent_keep_stronger_diagnosis_in_either_event_order(self):
        for kind in (17, 18, 21):
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

    def test_property_event_cannot_downgrade_an_existing_observed_mismatch(self):
        source, _calls = self.fixture([28])
        source.invalid = 'window_identity_changed'
        source.drain()
        self.assertEqual(source.invalid, 'window_identity_changed')


class DiscoveryDiagnosticTests(unittest.TestCase):
    def fixture(self, **overrides):
        source = module.X11WindowSource.__new__(module.X11WindowSource)
        source.d, source.root = None, 1
        source.clients = lambda: [123]
        source.sync = lambda: None
        attributes = dict(width=4, height=3, depth=24, border_width=0,
                          map_state=2, override_redirect=0)
        attributes.update(overrides)
        calls = []

        class Xlib:
            def XGetWindowAttributes(self, _display, window, target):
                calls.append(('attributes', window))
                value = module.Attributes(**attributes)
                C.memmove(target, C.byref(value), C.sizeof(value))
                return 1

            def XTranslateCoordinates(self, _display, window, _root, _x, _y, x, y, _child):
                calls.append(('translate', window))
                x._obj.value, y._obj.value = 10, 20
                return 1

        source.x = Xlib()
        source.prop = lambda _window, name, _fmt: {
            '_NET_WM_PID': [456], '_NET_WM_NAME': b'Public test', 'WM_CLASS': b'Test'}[name]
        return source, calls

    def identity(self, source, require_opaque=True):
        class FakePath:
            def __init__(self, _path):
                self.name = 'test-app'
            def __truediv__(self, _name):
                return self
            def stat(self):
                return type('Stat', (), {'st_uid': module.os.getuid()})()
            def read_text(self):
                return '456 (synthetic) ' + ' '.join(['0'] * 19 + ['789'])

        with patch.object(module, 'Path', FakePath), patch.object(module.os, 'readlink', return_value='/synthetic/app'):
            return source.identity(123, require_opaque=require_opaque)

    def test_eligible_identity_remains_exact_and_has_no_diagnostics(self):
        source, calls = self.fixture()
        self.assertEqual(self.identity(source), {
            'window_id': 'x11:123', 'owner_pid': 456, 'owner_process_start': '789',
            'owner_process_name': 'test-app', 'wm_class': 'Test', 'window_title': 'Public test',
            'content_bounds': {'x': 10, 'y': 20, 'width': 4, 'height': 3}})
        self.assertEqual(calls, [('attributes', 123), ('translate', 123)])

    def test_every_existing_metadata_guard_still_rejects_with_legacy_error(self):
        cases = [({'map_state': 0}, 'not_viewable'), ({'map_state': 1}, 'not_viewable'),
                 ({'override_redirect': 1}, 'not_standard_window'),
                 ({'depth': 32}, 'unsupported_format'), ({'depth': 16}, 'unsupported_format'),
                 ({'border_width': 1}, 'bordered_window'), ({'border_width': -1}, 'bordered_window'),
                 ({'width': 0}, 'invalid_size'), ({'height': 0}, 'invalid_size'),
                 ({'width': -1}, 'invalid_size'), ({'width': 4001, 'height': 4000}, 'invalid_size')]
        for attributes, reason in cases:
            with self.subTest(attributes=attributes):
                source, calls = self.fixture(**attributes)
                with self.assertRaises(ValueError) as caught:
                    self.identity(source)
                self.assertEqual(str(caught.exception), 'opaque_visible_client_required')
                self.assertEqual(module.discovery_rejection_reason(caught.exception), reason)
                self.assertEqual(calls, [('attributes', 123)])

    def test_exact_area_limit_still_accepted(self):
        source, _calls = self.fixture(width=4000, height=4000)
        self.assertEqual(self.identity(source)['content_bounds']['width'], 4000)

    def test_foreground_metadata_exemption_unchanged(self):
        source, _calls = self.fixture(depth=32, border_width=1)
        self.assertEqual(self.identity(source, require_opaque=False)['window_id'], 'x11:123')
        for attributes in ({'map_state': 0}, {'override_redirect': 1}, {'width': 0},
                           {'width': 4001, 'height': 4000}):
            source, _calls = self.fixture(**attributes)
            with self.assertRaisesRegex(ValueError, 'opaque_visible_client_required'):
                self.identity(source, require_opaque=False)

    def test_one_bounded_reason_per_rejected_candidate(self):
        source, _calls = self.fixture(map_state=0, override_redirect=1, depth=32, width=0)
        with self.assertRaises(module.DiscoveryRejection) as caught:
            self.identity(source)
        self.assertEqual(caught.exception.reason, 'not_viewable')

    def test_mixed_refresh_keeps_eligible_sources_and_only_allowlisted_counts(self):
        source, _calls = self.fixture()
        accepted = self.identity(source)
        source.clients = lambda: list(range(10))
        failures = [module.DiscoveryRejection(reason) for reason in module.DISCOVERY_REASONS[:5]]
        failures += [ValueError('window_identity_unavailable'), ValueError('private_title_x11_991'),
                     OSError('/private/process/path'), UnicodeError('private window title')]
        def identity(window):
            if window == 0:
                return accepted
            raise failures[window - 1]
        source.identity = identity
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            result, pixels = source.command({'action': 'list'})
        self.assertIsNone(pixels)
        self.assertEqual(result['sources'], [accepted])
        self.assertEqual(result['diagnostics'], {'rejected_counts': dict(zip(module.DISCOVERY_REASONS, [1, 1, 1, 1, 1, 1, 3]))})
        self.assertEqual(output.getvalue() + errors.getvalue(), '')
        serialized = module.json.dumps(result)
        for secret in ('private_title', '991', '/private/process/path', 'private window title'):
            self.assertNotIn(secret, serialized)
        source.clients = lambda: []
        next_result, _ = source.command({'action': 'list'})
        self.assertEqual(sum(next_result['diagnostics']['rejected_counts'].values()), 0)
        self.assertFalse(hasattr(source, 'diagnostics'))

    def test_known_identity_failures_have_fixed_category(self):
        for code in ('client_window_required', 'window_source_unavailable', 'window_bounds_unavailable',
                     'window_identity_unavailable', 'window_owner_unavailable'):
            self.assertEqual(module.discovery_rejection_reason(ValueError(code)), 'identity_unavailable')
        self.assertEqual(module.discovery_rejection_reason(module.DiscoveryRejection('private_unknown_reason')), 'unknown_error')

    def test_unexpected_failure_aborts_without_exposing_partial_sources(self):
        source, _calls = self.fixture()
        def fail(_window):
            raise RuntimeError('private unexpected failure')
        source.identity = fail
        with self.assertRaises(RuntimeError):
            source.command({'action': 'list'})

    def test_existing_candidate_limit_bounds_aggregation(self):
        source, _calls = self.fixture()
        del source.clients
        source.prop = lambda *_args: list(range(200))
        source.identity = lambda _window: (_ for _ in ()).throw(module.DiscoveryRejection('unsupported_format'))
        result, pixels = source.command({'action': 'list'})
        self.assertEqual(result['sources'], [])
        self.assertIsNone(pixels)
        self.assertEqual(result['diagnostics']['rejected_counts']['unsupported_format'], 200)
        self.assertEqual(sum(result['diagnostics']['rejected_counts'].values()), 200)
        source.prop = lambda *_args: list(range(201))
        with self.assertRaisesRegex(ValueError, 'window_list_unavailable'):
            source.command({'action': 'list'})


if __name__ == '__main__':
    unittest.main()
