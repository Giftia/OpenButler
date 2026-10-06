"""Synthetic loopback coverage for bounded CPU requests; no real model service."""
from copy import deepcopy
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from app.modules.model_gateway.tests.local_provider_fixture import LocalProviderMetadata
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

from app.modules.model_gateway.gateway import (
    CallAuthorization, Gateway, HttpTransport, ModelRoute, OBSERVATION_JSON_SCHEMA,
    OBSERVATION_NO_PRIOR_JSON_SCHEMA, OBSERVATION_CURRENT_FRAME_BOUNDARY,
    RouteError, _payload, synthetic_probe_png,
)
from app.modules.model_gateway.router import create_model_settings_router
from app.modules.model_gateway.tests.test_llama_timings import synthetic_timings
from app.security.privacy_guard import PrivacyGuard

MODULE = 'app.modules.model_gateway.gateway'


class LocalHandler(LocalProviderMetadata, BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append(payload)
        self.server.dispatched.set()
        is_openai = self.path.endswith('/chat/completions')
        message = {'role': 'assistant', 'content': self.server.content}
        message.update(self.server.message_extra)
        response = ({'choices': [{'message': message, 'finish_reason': self.server.finish}]}
                    if is_openai else {'message': message, 'done': True, 'done_reason': self.server.finish})
        response.update(self.server.response_extra)
        data = json.dumps(response).encode()
        if self.server.delay:
            self.server.release.wait(self.server.delay)
        try:
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if self.server.drip:
                for char in data:
                    self.wfile.write(bytes([char]))
                    self.wfile.flush()
                    time.sleep(.015)
            else:
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_):
        pass


class LocalBudgetSchemaTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), LocalHandler)
        self.server.daemon_threads = True
        self.server.calls = []
        self.server.dispatched = threading.Event()
        self.server.release = threading.Event()
        self.server.content = json.dumps({'title': 'Synthetic', 'summary': 'A synthetic fixture is visible.',
            'boundary': 'Synthetic pixels only.', 'comparison': {'performed': False,
            'prior_observation_ids': [], 'current_quote': '', 'prior_quote': ''}})
        self.server.finish = 'stop'
        self.server.message_extra = {}
        self.server.response_extra = {}
        self.server.delay = 0
        self.server.drip = False
        self.worker = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.worker.start()
        self.auth = CallAuthorization(authorized=True, redacted=True)

    def tearDown(self):
        self.server.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(1)

    def route(self, protocol='ollama_native'):
        suffix = '/v1' if protocol == 'openai_compatible' else ''
        return ModelRoute(protocol, 'local', f'http://127.0.0.1:{self.server.server_port}{suffix}', 'synthetic')

    def gateway(self, protocol='ollama_native', transport=None):
        gateway = Gateway(PrivacyGuard(), transport or HttpTransport())
        route = self.route(protocol)
        gateway._configuration = (1, {'image': route, 'text': route})
        return gateway

    def test_local_deadline_explicit_bounded_and_default_unchanged(self):
        self.assertEqual(HttpTransport().local_total_timeout, 10)
        self.assertEqual(HttpTransport(total_timeout=.15).local_total_timeout, .15)
        for value in [True, False, 0, -1, 120.1, float('nan'), float('inf'), '90']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_local_transport_deadline'):
                HttpTransport(local_total_timeout=value)
        for value in [10.1, 90, 120, True, float('nan')]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_transport_deadline'):
                HttpTransport(total_timeout=value)
        self.assertEqual(HttpTransport(local_total_timeout=120).local_total_timeout, 120)

    def test_larger_local_budget_allows_delayed_response(self):
        self.server.delay = .12
        with self.assertRaises(RouteError):
            self.gateway(transport=HttpTransport(total_timeout=.05)).call_text('JSON fixture', self.auth)
        gateway = self.gateway(transport=HttpTransport(total_timeout=.05, local_total_timeout=.5))
        self.assertEqual(gateway.call_text('JSON fixture', self.auth), self.server.content)

    def test_external_never_uses_local_budget_or_local_resource_options(self):
        route = ModelRoute('openai_compatible', 'custom', 'https://example.com/v1', 'synthetic')
        response = Mock(status=200)
        response.read.return_value = b'{"synthetic":true}'
        connection = Mock(active_socket=None)
        connection.getresponse.return_value = response
        with patch(MODULE + '._pinned_address', return_value='93.184.216.34'), \
                patch(MODULE + '._PinnedHTTP', return_value=connection) as http, \
                patch(MODULE + '.Timer') as timer:
            before = time.monotonic()
            self.assertEqual(HttpTransport(local_total_timeout=90).post(route, {'synthetic': True}), {'synthetic': True})
            deadline = http.call_args.kwargs['deadline']
            self.assertGreater(deadline - before, 9.9)
            self.assertLess(deadline - before, 10.2)
            self.assertGreater(timer.call_args.args[0], 9.9)
            self.assertLessEqual(timer.call_args.args[0], 10)
        payload = _payload(route, 'JSON fixture', None)
        self.assertNotIn('max_tokens', payload)
        self.assertNotIn('temperature', payload)
        self.assertNotIn('options', payload)

    def test_local_slow_drip_respects_selected_total_and_joins_watchdogs(self):
        self.server.drip = True
        before_threads = {thread.ident for thread in threading.enumerate() if isinstance(thread, threading.Timer)}
        start = time.monotonic()
        with self.assertRaises(RouteError):
            self.gateway(transport=HttpTransport(local_total_timeout=.12)).call_text('JSON fixture', self.auth)
        self.assertLess(time.monotonic() - start, .7)
        after_threads = {thread.ident for thread in threading.enumerate() if isinstance(thread, threading.Timer)}
        self.assertEqual(before_threads, after_threads)

    def test_schema_provider_wire_and_output_resource_caps(self):
        for protocol in ['ollama_native', 'openai_compatible']:
            with self.subTest(protocol=protocol):
                result = self.gateway(protocol).call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA,
                                                          local_cpu_profile='observation')
                self.assertEqual(result, self.server.content)
                payload = self.server.calls[-1]
                if protocol == 'ollama_native':
                    self.assertEqual(payload['format'], OBSERVATION_JSON_SCHEMA)
                    self.assertEqual(payload['options']['num_ctx'], 2048)
                    self.assertEqual(payload['options']['num_predict'], 768)
                    self.assertTrue(1 <= payload['options']['num_thread'] <= 6)
                else:
                    self.assertEqual(payload['response_format'], {'type': 'json_schema', 'json_schema': {
                        'name': 'openbutler_observation', 'strict': True, 'schema': OBSERVATION_JSON_SCHEMA}})
                    self.assertEqual(payload['max_tokens'], 768)
        self.assertEqual(_payload(self.route(), 'image fixture', synthetic_probe_png(),
                                  local_cpu_profile='observation')['options']['num_predict'], 512)

    def test_no_prior_schema_fixes_empty_comparison_and_boundary_on_both_wires(self):
        schema = OBSERVATION_NO_PRIOR_JSON_SCHEMA
        comparison = schema['properties']['comparison']['properties']
        self.assertEqual(comparison['performed'], {'type': 'boolean', 'enum': [False]})
        self.assertEqual(comparison['prior_observation_ids']['maxItems'], 0)
        self.assertEqual(comparison['current_quote']['enum'], [''])
        self.assertEqual(comparison['prior_quote']['enum'], [''])
        self.assertEqual(schema['properties']['boundary']['enum'], [OBSERVATION_CURRENT_FRAME_BOUNDARY])
        self.assertEqual(OBSERVATION_JSON_SCHEMA['properties']['comparison']['properties']
                         ['prior_observation_ids']['maxItems'], 3)
        self.assertNotIn('enum', OBSERVATION_JSON_SCHEMA['properties']['boundary'])
        for protocol in ['ollama_native', 'openai_compatible']:
            with self.subTest(protocol=protocol):
                self.gateway(protocol).call_text('JSON fixture', self.auth, json_schema=schema,
                                                local_cpu_profile='observation')
                payload = self.server.calls[-1]
                selected = payload['format'] if protocol == 'ollama_native' else payload['response_format']['json_schema']['schema']
                self.assertEqual(selected, schema)

    def test_no_prior_allowlist_rejects_mutation_and_type_coercion(self):
        original = deepcopy(OBSERVATION_NO_PRIOR_JSON_SCHEMA)
        variants = []
        for field, value in [('performed', {'type': 'boolean', 'enum': [0]}),
                             ('current_quote', {'type': 'string', 'maxLength': 300}),
                             ('prior_quote', {'type': 'string', 'maxLength': 300})]:
            changed = deepcopy(original)
            changed['properties']['comparison']['properties'][field] = value
            variants.append(changed)
        changed = deepcopy(original)
        changed['properties']['boundary']['enum'] = ['<80']
        variants.append(changed)
        for schema in variants:
            with self.assertRaisesRegex(RouteError, 'invalid_json_schema'):
                self.gateway().call_text('JSON fixture', self.auth, json_schema=schema)
        self.assertEqual(self.server.calls, [])
        try:
            OBSERVATION_NO_PRIOR_JSON_SCHEMA['additionalProperties'] = True
            with self.assertRaisesRegex(RouteError, 'invalid_json_schema'):
                self.gateway().call_text('JSON fixture', self.auth, json_schema=OBSERVATION_NO_PRIOR_JSON_SCHEMA)
            self.assertEqual(self.gateway().call_text('JSON fixture', self.auth, json_schema=original), self.server.content)
        finally:
            OBSERVATION_NO_PRIOR_JSON_SCHEMA.clear()
            OBSERVATION_NO_PRIOR_JSON_SCHEMA.update(original)

    def test_legacy_local_calls_and_probes_keep_wire_behavior_without_profile(self):
        for protocol in ['ollama_native', 'openai_compatible']:
            for image in [None, synthetic_probe_png()]:
                payload = _payload(self.route(protocol), 'fixture', image)
                self.assertNotIn('options', payload)
                self.assertNotIn('temperature', payload)
                self.assertNotIn('max_tokens', payload)
        custom = ModelRoute('ollama_native', 'custom', 'https://example.com', 'synthetic')
        self.assertNotIn('options', _payload(custom, 'fixture', None, local_cpu_profile='observation'))
        for invalid in ['planner', True, 90]:
            with self.assertRaisesRegex(RouteError, 'invalid_local_cpu_profile'):
                self.gateway().call_text('fixture', self.auth, local_cpu_profile=invalid)
        self.assertEqual(self.server.calls, [])

    def test_untrusted_or_excessive_schema_rejected_before_dispatch(self):
        altered = deepcopy(OBSERVATION_JSON_SCHEMA)
        altered['additionalProperties'] = True
        boolean_alias = deepcopy(OBSERVATION_JSON_SCHEMA)
        boolean_alias['additionalProperties'] = 0
        cyclic = {}; cyclic['properties'] = cyclic
        for schema in [altered, boolean_alias, {'$ref': 'https://example.com/schema'}, cyclic,
                       {'properties': ['x'] * 1000}, {'description': 'x' * 1001}]:
            with self.subTest(schema_type=type(schema)), self.assertRaisesRegex(RouteError, 'invalid_json_schema'):
                self.gateway().call_text('JSON fixture', self.auth, json_schema=schema)
        self.assertEqual(self.server.calls, [])

    def test_exported_schema_mutation_does_not_expand_allowlist(self):
        original = deepcopy(OBSERVATION_JSON_SCHEMA)
        try:
            OBSERVATION_JSON_SCHEMA['additionalProperties'] = True
            with self.assertRaisesRegex(RouteError, 'invalid_json_schema'):
                self.gateway().call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA)
            self.assertEqual(self.gateway().call_text('JSON fixture', self.auth, json_schema=original), self.server.content)
        finally:
            OBSERVATION_JSON_SCHEMA.clear(); OBSERVATION_JSON_SCHEMA.update(original)

    def test_schema_forces_existing_strict_refusal_unknown_and_truncation_checks(self):
        for protocol in ['ollama_native', 'openai_compatible']:
            gateway = self.gateway(protocol)
            for extra in [{'thinking': ''}, {'tool_calls': []}, {'refusal': None}, {'unknown': 'x'}]:
                self.server.message_extra = extra
                with self.subTest(protocol=protocol, extra=extra), self.assertRaisesRegex(RouteError, 'invalid_provider_response'):
                    gateway.call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA)
            self.server.message_extra = {}
            self.server.finish = 'length'
            with self.assertRaisesRegex(RouteError, 'invalid_provider_response'):
                gateway.call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA)
            self.server.finish = 'stop'
            self.server.response_extra = {'unknown': 'x'}
            with self.assertRaisesRegex(RouteError, 'invalid_provider_response'):
                gateway.call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA)
            self.server.response_extra = {}

    def test_local_openai_timings_pass_real_transport_probe_and_schema_call(self):
        self.server.response_extra = {'timings': synthetic_timings()}
        gateway = self.gateway('openai_compatible')
        content = self.server.content
        self.server.content = 'READY'
        gateway.configure_text(text=self.route('openai_compatible'), auth=self.auth)
        self.server.content = content
        self.assertEqual(gateway.call_text('JSON fixture', self.auth,
                         json_schema=OBSERVATION_JSON_SCHEMA, local_cpu_profile='observation'), content)
        self.assertEqual(len(self.server.calls), 2)

    def test_local_openai_malformed_timings_and_extra_fields_fail_real_transport(self):
        gateway = self.gateway('openai_compatible')
        for extra in [{'timings': {**synthetic_timings(), 'prompt_ms': float('nan')}},
                      {'timings': {**synthetic_timings(), 'cache_n': True}},
                      {'timings': {**synthetic_timings(), 'unknown': 0}},
                      {'timings': synthetic_timings(), 'unknown': 0}]:
            self.server.response_extra = extra
            with self.subTest(extra=extra), self.assertRaisesRegex(RouteError, 'invalid_provider_response'):
                gateway.call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA)

    def test_observation_profile_requires_normal_stop_for_capped_image(self):
        self.server.finish = 'length'
        with self.assertRaisesRegex(RouteError, 'invalid_provider_response'):
            self.gateway().call_image('image fixture', synthetic_probe_png(), self.auth,
                                      local_cpu_profile='observation')

    def test_gateway_never_repairs_model_json_or_strips_fences(self):
        self.server.content = '```json\n' + self.server.content + '\n```'
        self.assertEqual(self.gateway().call_text('JSON fixture', self.auth, json_schema=OBSERVATION_JSON_SCHEMA),
                         self.server.content)
        # Processor's unchanged strict JSON parsing must reject this string.
        with self.assertRaises(json.JSONDecodeError):
            json.loads(self.server.content)

    def test_already_cancelled_request_never_dispatches(self):
        cancelled = threading.Event(); cancelled.set()
        with self.assertRaisesRegex(PermissionError, 'authorization_revoked'):
            self.gateway().call_text('JSON fixture', self.auth, cancel_event=cancelled)
        with self.assertRaisesRegex(PermissionError, 'authorization_revoked'):
            HttpTransport(local_total_timeout=90).post(self.route(), {'model': self.route().model}, cancel_event=cancelled)
        self.assertEqual(self.server.calls, [])

    def test_inflight_cancellation_physically_aborts_and_joins_watchdogs(self):
        self.server.delay = 5
        cancelled = threading.Event()
        gateway = self.gateway(transport=HttpTransport(local_total_timeout=90))
        outcomes = []
        before = {thread.ident for thread in threading.enumerate()
                  if isinstance(thread, threading.Timer) or thread.name == 'model-http-cancellation'}
        def call():
            try:
                gateway.call_image('image fixture', synthetic_probe_png(), self.auth,
                                   cancel_event=cancelled, strict_text_response=True)
            except Exception as error:
                outcomes.append(error)
        worker = threading.Thread(target=call)
        worker.start()
        self.assertTrue(self.server.dispatched.wait(1))
        start = time.monotonic(); cancelled.set(); worker.join(.7)
        self.assertFalse(worker.is_alive())
        self.assertLess(time.monotonic() - start, .7)
        self.assertEqual(len(outcomes), 1)
        self.assertIsInstance(outcomes[0], PermissionError)
        self.assertEqual(str(outcomes[0]), 'authorization_revoked')
        after = {thread.ident for thread in threading.enumerate()
                 if isinstance(thread, threading.Timer) or thread.name == 'model-http-cancellation'}
        self.assertEqual(before, after)

    def test_cancellation_during_connect_does_not_wait_for_local_budget(self):
        connected = threading.Event()
        cancelled = threading.Event()
        sock = Mock()
        sock.connect_ex.return_value = errno.EINPROGRESS
        def waiting_select(_read, _write, _error, timeout):
            connected.set()
            time.sleep(timeout)
            return [], [], []
        errors = []
        def call():
            try:
                HttpTransport(local_total_timeout=90).post(self.route(), {'model': self.route().model}, cancel_event=cancelled)
            except Exception as error:
                errors.append(error)
        with patch(MODULE + '.socket.socket', return_value=sock), \
                patch(MODULE + '.select.select', side_effect=waiting_select):
            worker = threading.Thread(target=call)
            worker.start()
            self.assertTrue(connected.wait(1))
            start = time.monotonic()
            cancelled.set()
            worker.join(.5)
            self.assertFalse(worker.is_alive())
            self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], PermissionError)
        self.assertEqual(str(errors[0]), 'authorization_revoked')
        self.assertTrue(sock.close.called)
        self.assertEqual(self.server.calls, [])

    def test_postflight_guard_revocation_discards_successful_response(self):
        calls = []
        def check():
            calls.append(True)
            if len(calls) == 3:
                raise PermissionError('authorization_revoked')
        with self.assertRaisesRegex(PermissionError, 'authorization_revoked'):
            self.gateway().call_text('JSON fixture', self.auth, dispatch_precondition=check,
                                     json_schema=OBSERVATION_JSON_SCHEMA)
        self.assertEqual(len(self.server.calls), 1)

    def test_trusted_environment_budget_public_status_and_invalid_fail_closed(self):
        with patch.dict('os.environ', {'OPENBUTLER_LOCAL_MODEL_TOTAL_TIMEOUT_SECONDS': '90'}):
            router = create_model_settings_router(lambda: None, lambda: 'strict', lambda _: None)
            status = next(route.endpoint for route in router.routes if route.path == '/api/model_settings/get')()
            self.assertEqual(status['local_total_timeout_seconds'], 90)
            self.assertEqual(status['external_total_timeout_seconds'], 10)
        for value in ['120.1', '0', 'nan', 'inf', 'not-a-number']:
            with self.subTest(value=value), patch.dict('os.environ', {'OPENBUTLER_LOCAL_MODEL_TOTAL_TIMEOUT_SECONDS': value}), \
                    self.assertRaisesRegex(ValueError, 'invalid_local_transport_deadline'):
                create_model_settings_router(lambda: None, lambda: 'strict', lambda _: None)


if __name__ == '__main__':
    unittest.main()

