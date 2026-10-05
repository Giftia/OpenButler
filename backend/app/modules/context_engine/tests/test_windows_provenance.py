import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from pydantic import ValidationError
from app.modules.context_engine.capture import CaptureSettings

class WindowsProvenanceTests(unittest.TestCase):
    def payload(self):
        return dict(display_id='hwnd:123',excluded_apps=['vault'],confirmed=True,
            source_kind='public_window',capture_scope='dedicated_public_window',session_id=str(uuid4()),
            source_revision='a'*64,source_identity=dict(window_id='hwnd:123',owner_pid=456,owner_process_start='789',
                owner_process_name='fixture.exe',wm_class='publicFixture',window_title='Public fixture',
                content_bounds=dict(x=1,y=2,width=100,height=100)),
            session_expires_at=(datetime.now(timezone.utc)+timedelta(minutes=1)).isoformat(),
            lock_state='unlocked',lock_protection_supported=True,capture_method='windows_wgc_hwnd',sampling_interval_ms=10000)

    def test_native_windows_contract_and_unsupported_cross_platform_claims(self):
        self.assertEqual(CaptureSettings(**self.payload()).capture_method,'windows_wgc_hwnd')
        for change in (dict(lock_state='unknown'),dict(lock_protection_supported=False),dict(capture_method='xcomposite_named_window_pixmap')):
            with self.assertRaises(ValidationError):CaptureSettings(**(self.payload()|change))
        value=self.payload();value['source_identity']['window_id']='x11:123'
        with self.assertRaises(ValidationError):CaptureSettings(**value)
