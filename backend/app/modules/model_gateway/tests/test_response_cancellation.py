"""Actual loopback response reads; no models, source data or OS changes."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from app.modules.model_gateway.tests.local_provider_fixture import LocalProviderMetadata
import threading
import time
import unittest

from app.modules.model_gateway.gateway import HttpTransport, ModelRoute, RouteError


class Handler(LocalProviderMetadata, BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        data = b'{"fixture":"complete"}'
        try:
            if request['kind'] == 'headers':
                self.server.entered.set()
                self.server.release.wait(5)
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if request['kind'] == 'body':
                self.wfile.write(data[:4]); self.wfile.flush()
                self.server.entered.set()
                self.server.release.wait(5)
                self.wfile.write(data[4:])
            else:
                if request['kind'] == 'delayed':
                    time.sleep(.15)
                self.wfile.write(data)
        except OSError:
            pass  # The owned cancellation test deliberately aborts its socket.

    def log_message(self, *_):
        pass


class ResponseCancellationTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.server.entered = threading.Event()
        self.server.release = threading.Event()
        self.server_thread = threading.Thread(target=self.server.serve_forever,
                                              kwargs={'poll_interval': .02})
        self.server_thread.start()
        self.route = ModelRoute('ollama_native', 'local',
                                f'http://127.0.0.1:{self.server.server_port}', 'fixture')
        self.transport = HttpTransport(local_total_timeout=90)
        self.workers = []

    def tearDown(self):
        self.server.release.set()
        for worker in self.workers:
            worker.join(2)
        self.server.shutdown(); self.server.server_close(); self.server_thread.join(1)

    def call_in_thread(self, kind, cancelled):
        outcomes = []
        def call():
            try:
                outcomes.append(self.transport.post(self.route, {'model': self.route.model, 'kind': kind}, cancel_event=cancelled))
            except Exception as error:
                outcomes.append(error)
        worker = threading.Thread(target=call)
        self.workers.append(worker); worker.start()
        return worker, outcomes

    def test_cancel_partial_body_exits_before_server_release_and_is_isolated(self):
        before = {t.ident for t in threading.enumerate()
                  if isinstance(t, threading.Timer) or t.name == 'model-http-cancellation'}
        cancelled = threading.Event()
        worker, outcomes = self.call_in_thread('body', cancelled)
        self.assertTrue(self.server.entered.wait(1))
        independent, success = self.call_in_thread('delayed', threading.Event())
        start = time.monotonic()
        cancelled.set(); cancelled.set()  # Repeated revocation is idempotent.
        worker.join(.7)
        self.assertFalse(worker.is_alive())
        self.assertLess(time.monotonic() - start, .7)
        self.assertFalse(self.server.release.is_set())
        self.assertEqual(len(outcomes), 1)
        self.assertIsInstance(outcomes[0], PermissionError)
        self.assertEqual(str(outcomes[0]), 'authorization_revoked')
        independent.join(.7)
        self.assertFalse(independent.is_alive())
        self.assertEqual(success, [{'fixture': 'complete'}])
        after = {t.ident for t in threading.enumerate()
                 if isinstance(t, threading.Timer) or t.name == 'model-http-cancellation'}
        self.assertEqual(before, after)

    def test_poll_timeouts_preserve_http10_delayed_response(self):
        # Multiple short raw waits must not poison a buffered makefile, or lose
        # its socket when HTTPConnection detaches a Connection:close response.
        self.assertEqual(self.transport.post(self.route, {'model': self.route.model, 'kind': 'delayed'}), {'fixture': 'complete'})

    def test_partial_body_total_deadline_exits_without_server_release(self):
        self.transport = HttpTransport(local_total_timeout=.12)
        start = time.monotonic()
        with self.assertRaises(RouteError):
            self.transport.post(self.route, {'model': self.route.model, 'kind': 'body'})
        self.assertLess(time.monotonic() - start, .7)
        self.assertFalse(self.server.release.is_set())

