"""Typed timeout classification using mocked connections; no provider calls."""
from threading import Event
from time import monotonic
import unittest
from unittest.mock import Mock, patch

from app.modules.model_gateway.gateway import HttpTransport, ModelRoute, ProviderTimeoutError, RouteError

MODULE = 'app.modules.model_gateway.gateway'


class TimeoutClassificationTests(unittest.TestCase):
    def setUp(self):
        self.route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')
        self.connection = Mock(active_socket=None)
        self.http = patch(MODULE + '._PinnedHTTP', return_value=self.connection)
        self.timer = patch(MODULE + '.Timer')
        self.http.start(); self.timer.start()
        self.addCleanup(self.http.stop); self.addCleanup(self.timer.stop)

    def request(self, **kwargs):
        return HttpTransport()._request(self.route, 'GET' if kwargs.get('metadata') else 'POST',
            '/synthetic', None, deadline=kwargs.pop('deadline', monotonic() + 5), **kwargs)

    def test_typed_timeout_keeps_shared_gateway_code(self):
        self.connection.request.side_effect = TimeoutError('SYNTHETIC_PRIVATE_ERROR')
        with self.assertRaises(ProviderTimeoutError) as raised:
            self.request()
        self.assertEqual(str(raised.exception), 'provider_connection_failed')

    def test_exhausted_dispatch_deadline_has_typed_timeout_without_request(self):
        with self.assertRaises(ProviderTimeoutError):
            self.request(deadline=monotonic() - 1)
        self.connection.request.assert_not_called()

    def test_metadata_timeout_still_fails_locality_closed(self):
        self.connection.request.side_effect = TimeoutError('SYNTHETIC_PRIVATE_ERROR')
        for deadline in (monotonic() - 1, monotonic() + 5):
            with self.subTest(deadline=deadline), self.assertRaises(RouteError) as raised:
                self.request(metadata=True, deadline=deadline)
            self.assertIs(type(raised.exception), RouteError)
            self.assertEqual(str(raised.exception), 'local_model_unverified')

    def test_non_timeout_connection_failure_is_not_mislabeled(self):
        self.connection.request.side_effect = ConnectionError('SYNTHETIC_PRIVATE_ERROR')
        with self.assertRaises(RouteError) as raised:
            self.request()
        self.assertIs(type(raised.exception), RouteError)
        self.assertEqual(str(raised.exception), 'provider_connection_failed')

    def test_cancellation_has_priority_over_typed_timeout(self):
        cancelled = Event()
        def cancel_then_timeout(*_args, **_kwargs):
            cancelled.set()
            raise TimeoutError('SYNTHETIC_PRIVATE_ERROR')
        self.connection.request.side_effect = cancel_then_timeout
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            self.request(cancel_event=cancelled)


if __name__ == '__main__':
    unittest.main()
