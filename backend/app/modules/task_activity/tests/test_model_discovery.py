"""Synthetic source/model responses only; no model, capture, network or settings I/O."""
from copy import deepcopy
from contextlib import contextmanager
from dataclasses import replace
import json
from hashlib import sha256
from threading import Event, Thread
import unittest
from unittest.mock import patch

from app.modules.model_gateway.gateway import (
    CallAuthorization, Gateway, HttpTransport, ModelRoute, RouteError,
    TASK_DISCOVERY_JSON_SCHEMA,
)
from app.modules.model_gateway.tests.local_provider_fixture import ollama_tags
from app.modules.task_activity.discovery import DiscoveryResultError, Proposal
from app.modules.task_activity.model_discovery import LocalModelDiscovery, task_model_prompt, MAX_TASK_PROMPT_BYTES
from app.modules.task_activity.evidence import TaskModelSource, TaskContextIncomplete
from app.security.privacy_guard import PrivacyGuard


QUOTE = 'I still need to review the synthetic specification.'
ITEM = {'title': 'review the synthetic specification', 'quote': QUOTE,
        'self_assigned': True, 'unfinished': True, 'confidence': .95}


def model_source(text=QUOTE):
    return TaskModelSource('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222', 'a' * 64,
        sha256(text.encode('utf-8')).hexdigest(), text, 0, len(text))


class Guard(PrivacyGuard):
    def __init__(self):
        self.requests = []

    def require(self, request):
        self.requests.append(request)
        return super().require(request)


class Transport:
    def __init__(self):
        self.content = json.dumps({'proposals': [ITEM]})
        self.calls = []
        self.on_post = lambda: None
        self.message_extra = {}
        self.finish = 'stop'

    def post(self, route, payload, *, cancel_event):
        self.calls.append((route, payload, cancel_event))
        self.on_post()
        message = {'role': 'assistant', 'content': self.content, **self.message_extra}
        return ({'message': message, 'done': True, 'done_reason': self.finish}
                if route.protocol == 'ollama_native' else
                {'choices': [{'message': message, 'finish_reason': self.finish}]})


class LocalModelDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.guard, self.transport = Guard(), Transport()
        self.gateway = Gateway(self.guard, self.transport)
        self.route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')
        # Trusted synthetic fixture injection; never configure/probe a real route.
        self.gateway._configuration = (7, {'text': self.route})
        self.auth = CallAuthorization(authorized=True, redacted=True)
        self.provider = LocalModelDiscovery(self.gateway, lambda: self.auth)
        self.cancelled = Event()
        self.validations = []

    def validate(self):
        self.validations.append(len(self.transport.calls))

    def extract(self, source=None, validate=None):
        return self.provider.extract(model_source() if source is None else source, validate=validate or self.validate,
                                     cancel_event=self.cancelled)

    def test_constructor_and_availability_do_not_probe_or_call_authorization(self):
        with patch.object(self.gateway, 'call_text', side_effect=AssertionError('unexpected model call')), \
                patch.object(self.gateway, 'validate_route', side_effect=AssertionError('unexpected probe')):
            provider = LocalModelDiscovery(self.gateway, lambda: self.fail('unexpected authorization read'))
            self.assertEqual(provider.name, 'local_model_v1')
            self.assertTrue(provider.available())
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.guard.requests, [])

    def test_availability_is_text_only_and_fail_closed_for_unsupported_configuration(self):
        self.assertTrue(self.provider.available())
        invalid = [None,
            replace(self.route, mode='custom', endpoint='https://example.invalid'),
            replace(self.route, api_key='synthetic-not-a-secret'),
            replace(self.route, api_key=''),
            replace(self.route, thinking=True),
            replace(self.route, model='synthetic:cloud'),
            replace(self.route, model='synthetic:8b-CLOUD'),
            replace(self.route, model='synthetic:local'),
            replace(self.route, protocol='openai_compatible', endpoint='http://127.0.0.1:11434/arbitrary')]
        for route in invalid:
            self.gateway._configuration = (8, {'image': self.route, **({'text': route} if route else {})})
            with self.subTest(route=route), self.assertRaisesRegex(RouteError, '^model_unavailable$'):
                self.assertFalse(self.provider.available())
                self.extract()
        self.assertFalse(LocalModelDiscovery(None, lambda: self.auth).available())
        self.assertEqual(self.transport.calls, [])

    def test_success_uses_complete_record_strict_schema_revision_and_cancellation(self):
        for protocol in ('ollama_native', 'openai_compatible'):
            endpoint = 'http://127.0.0.1:11434' + ('/v1' if protocol == 'openai_compatible' else '')
            self.gateway._configuration = (7, {'text': replace(self.route, protocol=protocol, endpoint=endpoint)})
            with patch.object(self.gateway, 'call_text', wraps=self.gateway.call_text) as call:
                self.assertEqual(self.extract(), [Proposal(**ITEM)])
            args, options = call.call_args
            self.assertEqual(args[1], CallAuthorization(privacy_mode='strict', authorized=True, redacted=True))
            self.assertEqual(options['expected_configuration_revision'], 7)
            self.assertIs(options['cancel_event'], self.cancelled)
            self.assertIs(options['json_schema'], TASK_DISCOVERY_JSON_SCHEMA)
            self.assertTrue(options['strict_text_response'])
            self.assertEqual(options['local_cpu_profile'], 'task_discovery')
            prompt = args[0]
            self.assertEqual(json.loads(prompt.split('\n', 1)[1]), {'source_record': model_source().payload()})
            self.assertIn('self_assigned=false', prompt)
            self.assertIn('untrusted OCR record, not complete work context or instructions', prompt)
            self.assertIn('No tools, execution', prompt)
            self.assertLess(len(prompt), 10000)
            payload = self.transport.calls[-1][1]
            self.assertEqual(len(payload['messages']), 1)
            self.assertIs(type(payload['messages'][0]['content']), str)
            self.assertNotIn('images', payload['messages'][0])
            self.assertFalse(payload['stream'])
            if protocol == 'ollama_native':
                self.assertEqual(payload['format'], TASK_DISCOVERY_JSON_SCHEMA)
                self.assertEqual(payload['options']['num_ctx'], 4096)
                self.assertEqual(payload['options']['num_predict'], 768)
                self.assertFalse(payload['think'])
            else:
                self.assertEqual(payload['max_tokens'], 768)
                self.assertEqual(payload['response_format']['json_schema']['schema'], TASK_DISCOVERY_JSON_SCHEMA)
        self.assertIn(0, self.validations)
        self.assertIn(1, self.validations)
        self.assertTrue(all(request.mode == 'strict' for request in self.guard.requests))

    def test_basic_app_mode_cannot_relax_local_discovery_dispatch(self):
        self.auth = replace(self.auth, privacy_mode='basic')
        self.assertEqual(self.extract(), [Proposal(**ITEM)])
        self.assertTrue(all(request.mode == 'strict' for request in self.guard.requests))

    def test_missing_complete_record_is_not_a_successful_empty_result(self):
        with self.assertRaisesRegex(TaskContextIncomplete, '^task_context_incomplete$'):
            self.extract(())
        self.assertEqual(self.transport.calls, [])

    def test_invalid_or_overbudget_sources_never_dispatch(self):
        for source in ([QUOTE], 'whole OCR', (QUOTE,), model_source(' '),
                       model_source('文' * 700), replace(model_source(), start=1),
                       replace(model_source(), end=True), replace(model_source(), source_text_digest='0' * 64)):
            with self.subTest(source=source), self.assertRaisesRegex(TaskContextIncomplete, '^task_context_incomplete$'):
                self.extract(source)
        self.assertEqual(self.transport.calls, [])

    def test_complete_unicode_record_is_accepted_without_ascii_expansion(self):
        self.transport.content = '{"proposals":[]}'
        source = model_source('文' * 100 + '\r\n' + '字' * 80)
        self.assertEqual(self.extract(source), [])
        prompt = self.transport.calls[-1][1]['messages'][0]['content']
        self.assertEqual(json.loads(prompt.split('\n', 1)[1]), {'source_record': source.payload()})
        self.assertIn('文' * 100, prompt)
        self.assertLessEqual(len(prompt.encode('utf-8')), MAX_TASK_PROMPT_BYTES)

    def test_explicit_guard_context_is_required(self):
        for validate, cancel in ((None, self.cancelled), (self.validate, None), (self.validate, object())):
            with self.assertRaisesRegex(ValueError, '^invalid_discovery_context$'):
                self.provider.extract(model_source(), validate=validate, cancel_event=cancel)
        self.assertEqual(self.transport.calls, [])

    def test_invalid_authorization_never_dispatches(self):
        for auth in (None, {'authorized': True}, CallAuthorization(),
                     replace(self.auth, authorized=1), replace(self.auth, redacted=1),
                     replace(self.auth, redacted=False), replace(self.auth, privacy_mode='unknown')):
            self.auth = auth
            with self.subTest(auth=auth), self.assertRaisesRegex(PermissionError, '^model_unavailable$'):
                self.extract()
        self.assertEqual(self.transport.calls, [])

    def test_cancelled_request_never_dispatches(self):
        self.cancelled.set()
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            self.extract()
        self.assertEqual(self.transport.calls, [])

    def test_source_revocation_before_dispatch_never_calls_transport(self):
        def revoked():
            raise PermissionError('source_changed')
        with self.assertRaisesRegex(PermissionError, '^source_changed$'):
            self.extract(validate=revoked)
        self.assertEqual(self.transport.calls, [])

    def test_source_revocation_during_response_discards_output(self):
        source = {'valid': True}
        self.transport.on_post = lambda: source.update(valid=False)
        def validate():
            if not source['valid']:
                raise PermissionError('source_changed')
        with self.assertRaisesRegex(PermissionError, '^source_changed$'):
            self.extract(validate=validate)
        self.assertEqual(len(self.transport.calls), 1)

    def test_cancel_during_response_discards_output(self):
        self.transport.on_post = self.cancelled.set
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            self.extract()
        self.assertEqual(len(self.transport.calls), 1)

    def test_configuration_change_before_dispatch_discards_without_transport(self):
        def validate():
            self.validations.append(True)
            if len(self.validations) == 2:
                self.gateway._configuration = (8, {'text': self.route})
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            self.extract(validate=validate)
        self.assertEqual(self.transport.calls, [])

    def test_configuration_change_during_response_discards_output(self):
        self.transport.on_post = lambda: setattr(self.gateway, '_configuration', (8, {'text': self.route}))
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            self.extract()

    def test_authorization_change_during_response_discards_output(self):
        self.transport.on_post = lambda: setattr(self, 'auth', replace(self.auth, privacy_mode='basic'))
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            self.extract()

    def test_authorization_getter_is_never_called_under_dispatch_lock(self):
        def auth():
            self.assertFalse(self.gateway._dispatch_lock._is_owned())
            return self.auth
        self.provider.authorization = auth
        self.assertEqual(self.extract(), [Proposal(**ITEM)])

    def test_ambiguous_and_unfinished_flags_are_preserved_as_unverified_data(self):
        self.transport.content = json.dumps({'proposals': [{**ITEM, 'self_assigned': False,
                                                           'unfinished': False, 'confidence': .4}]})
        self.assertEqual(self.extract(), [Proposal(ITEM['title'], QUOTE, False, False, .4)])

    def test_exact_substrings_and_four_unique_items_are_accepted(self):
        self.transport.content = json.dumps({'proposals': [
            {**ITEM, 'title': str(i), 'quote': f'task {i}'} for i in range(4)]})
        result = self.extract(model_source('My tasks: task 0; task 1; task 2; task 3.'))
        self.assertEqual(len(result), 4)
        self.assertEqual([item.quote for item in result], [f'task {i}' for i in range(4)])

    def test_malformed_json_is_not_repaired_and_errors_are_content_free(self):
        invalid = ['```json\n{"proposals":[]}\n```', 'before {"proposals":[]}',
                   '{"proposals":[],"proposals":[]}', '{"proposals":[],}',
                   '{"proposals":[{"title":"a","title":"b"}]}',
                   '{"proposals":[],"reasoning":"SYNTHETIC_RAW_CONTENT"}',
                   '[]', 'null', '{"proposals":{}}', '{"proposals":[],' + '[' * 1100]
        for response in invalid:
            self.transport.content = response
            with self.subTest(response=response[:50]), self.assertRaisesRegex(ValueError, '^invalid_discovery_result$'):
                self.extract()
        self.assertEqual(len(self.transport.calls), len(invalid))

    def test_invalid_proposal_shape_types_and_bounds_reject_entire_batch(self):
        changes = [dict(title=''),
                   dict(title=' '), dict(title='x' * 201), dict(quote=''), dict(quote='x' * 201),
                   dict(title=3), dict(quote=None), dict(self_assigned='true'), dict(unfinished=1),
                   dict(confidence=True), dict(confidence='0.9'), dict(confidence=-.1),
                   dict(confidence=1.1), dict(confidence=None), dict(due_date='2030-01-01'),
                   dict(execute='send a message'), dict(status='done')]
        invalid = [{**ITEM, **change} for change in changes]
        invalid += [{key: value for key, value in ITEM.items() if key != 'quote'}, None]
        for item in invalid:
            self.transport.content = json.dumps({'proposals': [ITEM, item]})
            with self.subTest(item=item), self.assertRaisesRegex(ValueError, '^invalid_discovery_result$'):
                self.extract()
        for content in ('NaN', 'Infinity', '-Infinity', '1e9999'):
            self.transport.content = json.dumps({'proposals': [ITEM]}).replace('0.95', content)
            with self.assertRaisesRegex(ValueError, '^invalid_discovery_result$'):
                self.extract()

    def test_title_or_quote_source_mismatch_rejects_entire_batch_with_fixed_code(self):
        for change in ({'title': 'invented'},
                       {'title': 'unowned', 'quote': 'unowned quote'},
                       {'title': 'synthetic specification', 'quote': 'synthetic\nspecification'}):
            self.transport.content = json.dumps({'proposals': [ITEM, {**ITEM, **change}]})
            with self.subTest(change=change), self.assertRaisesRegex(
                    DiscoveryResultError, '^discovery_source_mismatch$'):
                self.extract()

    def test_duplicate_or_excess_proposals_reject_without_partial_result(self):
        for count in (2, 5):
            self.transport.content = json.dumps({'proposals': [ITEM] * count})
            with self.assertRaisesRegex(ValueError, '^invalid_discovery_result$'):
                self.extract()

    def test_transport_envelope_rejects_reasoning_tools_truncation_and_oversize(self):
        for extra in ({'thinking': 'synthetic'}, {'tool_calls': []}, {'refusal': 'synthetic'}):
            self.transport.message_extra = extra
            with self.assertRaisesRegex(RouteError, '^invalid_provider_response$'):
                self.extract()
        self.transport.message_extra = {}
        self.transport.finish = 'length'
        with self.assertRaisesRegex(RouteError, '^invalid_provider_response$'):
            self.extract()
        self.transport.finish = 'stop'
        self.transport.content = 'x' * 4097
        with self.assertRaisesRegex(RouteError, '^invalid_provider_response$'):
            self.extract()

    def test_commit_guard_preserves_list_contract_and_holds_policy_lock(self):
        proposals = self.extract()
        self.assertIsInstance(proposals, list)
        self.assertEqual(proposals, [Proposal(**ITEM)])
        with self.provider.commit_guard(proposals):
            self.assertTrue(self.gateway._dispatch_lock._is_owned())
        self.assertFalse(self.gateway._dispatch_lock._is_owned())

    def test_route_revision_changed_after_extract_cannot_enter_commit(self):
        proposals = self.extract()
        self.gateway._restore_validated_text_route(replace(self.route, model='different-synthetic'))
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            with self.provider.commit_guard(proposals):
                self.fail('stale extraction entered publication')
        self.assertEqual(len(self.transport.calls), 1)

    def test_authorization_changed_after_extract_cannot_enter_commit(self):
        for change in ({'authorized': False}, {'redacted': False}, {'privacy_mode': 'basic'},
                       {'authorized': 1}, {'redacted': 1}):
            self.auth = CallAuthorization(authorized=True, redacted=True)
            proposals = self.extract()
            self.auth = replace(self.auth, **change)
            with self.subTest(change=change), self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
                with self.provider.commit_guard(proposals):
                    self.fail('stale authorization entered publication')

    def test_source_cancelled_after_extract_cannot_enter_commit(self):
        proposals = self.extract()
        self.cancelled.set()
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            with self.provider.commit_guard(proposals):
                self.fail('cancelled extraction entered publication')

    def test_plain_foreign_and_mutated_batches_cannot_enter_commit(self):
        proposals = self.extract()
        other = LocalModelDiscovery(self.gateway, lambda: self.auth)
        for provider, batch in ((self.provider, list(proposals)), (other, proposals)):
            with self.assertRaisesRegex(PermissionError, '^invalid_discovery_receipt$'):
                with provider.commit_guard(batch):
                    self.fail('unowned extraction entered publication')
        proposals[0] = replace(proposals[0], self_assigned=1)
        # Dataclass equality considers 1 == True; receipt ownership is identity
        # based so an equal-but-replaced Proposal cannot bypass revalidation.
        with self.assertRaisesRegex(PermissionError, '^invalid_discovery_receipt$'):
            with self.provider.commit_guard(proposals):
                self.fail('mutated extraction entered publication')

    def test_concurrent_configuration_waits_until_commit_guard_exits(self):
        proposals = self.extract()
        started, configured = Event(), Event()
        def configure():
            started.set()
            self.gateway._restore_validated_text_route(replace(self.route, model='different-synthetic'))
            configured.set()
        worker = Thread(target=configure, daemon=True)
        try:
            with self.provider.commit_guard(proposals):
                worker.start()
                self.assertTrue(started.wait(1))
                self.assertFalse(configured.wait(.1))
                self.assertEqual(self.gateway.configuration_revision, 7)
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertTrue(configured.is_set())
            self.assertEqual(self.gateway.configuration_revision, 8)
        finally:
            if worker.ident is not None:
                worker.join(2)

    def test_production_transport_requires_explicit_authorization_guard_without_io(self):
        proposals = self.extract()
        self.gateway._transport = HttpTransport()
        with patch.object(self.gateway._transport, 'post', side_effect=AssertionError('unexpected I/O')):
            self.assertFalse(self.provider.available())
            with self.assertRaisesRegex(PermissionError, '^discovery_commit_guard_required$'):
                self.extract()
            with self.assertRaisesRegex(PermissionError, '^discovery_commit_guard_required$'):
                with self.provider.commit_guard(proposals):
                    self.fail('production publication used unsafe fallback')

    def test_injected_guard_authorization_is_authoritative_at_commit(self):
        current = {'auth': self.auth}
        @contextmanager
        def authorization_guard():
            with self.gateway._dispatch_lock:
                yield current['auth']
        self.provider.authorization_guard = authorization_guard
        proposals = self.extract()
        current['auth'] = replace(self.auth, authorized=False)
        with self.assertRaisesRegex(PermissionError, '^authorization_revoked$'):
            with self.provider.commit_guard(proposals):
                self.fail('stale getter snapshot bypassed current guard authorization')


class LocalityBoundaryTests(unittest.TestCase):
    def test_real_gateway_metadata_gate_denies_remote_and_revoked_sources_before_post(self):
        route = ModelRoute('ollama_native', 'local', 'http://127.0.0.1:11434', 'synthetic')
        for remote, revoked in ((True, False), (False, True)):
            with self.subTest(remote=remote, revoked=revoked):
                transport = HttpTransport()
                gateway = Gateway(PrivacyGuard(), transport)
                gateway._configuration = (1, {'text': route})
                auth = CallAuthorization(authorized=True, redacted=True)
                @contextmanager
                def authorization_guard():
                    with gateway._dispatch_lock:
                        yield auth
                provider = LocalModelDiscovery(gateway, lambda: auth,
                                               authorization_guard=authorization_guard)
                source = {'valid': True}
                tags = ollama_tags('synthetic')
                if remote:
                    tags['models'][0]['remote_model'] = 'remote-alias'
                def metadata(_route, method, path, payload, **_kwargs):
                    self.assertEqual((method, path, payload), ('GET', '/api/tags', None))
                    if revoked:
                        source['valid'] = False
                    return deepcopy(tags)
                def validate():
                    if not source['valid']:
                        raise PermissionError('source_changed')
                with patch.object(transport, '_request', side_effect=metadata) as request:
                    self.assertTrue(provider.available())
                    with self.assertRaisesRegex((RouteError, PermissionError),
                                                '^(local_model_remote|source_changed)$'):
                        provider.extract(model_source(), validate=validate, cancel_event=Event())
                    self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
