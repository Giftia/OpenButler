'use strict';
// Synthetic React/JSDOM only. No capture, evidence fetch, model request, or network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), {JSDOM} = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url: 'http://localhost/'});
for (const key of ['window', 'document', 'HTMLElement']) global[key] = dom.window[key];
Object.defineProperty(global, 'navigator', {value: dom.window.navigator, configurable: true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), {act} = React, {createRoot} = require('react-dom/client');
const options = {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020};
const file = path.resolve(__dirname, '../src/components/CaptureObservationFeed.tsx');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: options}).outputText;
const loaded = {exports: {}};
vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, {filename: file})(require, loaded, loaded.exports);
const {CaptureCoverageRow, CaptureObservationFeed, captureFeedEntries} = loaded.exports;
const root = createRoot(document.getElementById('root'));
const checks = [], check = name => checks.push(name);
const flush = () => new Promise(resolve => setImmediate(resolve));
const body = () => document.body.textContent;
const pause = {id: 'pause', kind: 'paused', occurred_at: '2026-10-03T10:05:00Z', source_kind: 'public_window',
  consent_revision: 'revision', session_id: 'session', first_sample_at: null, last_sample_at: '2026-10-03T10:04:00Z',
  gap_started_at: '2026-10-03T10:05:00Z', gap_end_at: null, gap_start_known: true, gap_end_known: false, reason: 'user_paused'};
const start = {...pause, id: 'start', kind: 'started', occurred_at: '2026-10-03T10:10:00Z', gap_started_at: null,
  gap_start_known: false, reason: 'started'};
const observation = {id: 'observation', captured_at: '2026-10-03T10:04:00Z', state: 'recorded_pending',
  title: null, summary: null, evidence_available: false, evidence_id: null, boundary: 'Unknown between samples', source_label: 'public window'};
const renderObservation = item => React.createElement('article', {'data-observation-id': item.id}, 'Saved sample');
async function feed(observations = [], coverageEvents, limit) {
  await act(async () => root.render(React.createElement(CaptureObservationFeed, {observations, coverageEvents, renderObservation, limit})));
}
async function row(event) { await act(async () => root.render(React.createElement(CaptureCoverageRow, {event}))); }

(async () => {
  await feed();
  for (const value of ['还没有本机记录或采集边界', '记录是离散采样', '旧版记录可能缺少', '没有边界记录不代表持续采集']) assert.ok(body().includes(value), value);
  check('empty and legacy responses disclose unknown coverage without inventing a record');
  await feed([], [pause]);
  for (const value of ['采集已暂停', '尚无后续接受采样', '空缺仍未关闭', '覆盖边界 · 非观察记录', '还没有已保存的观察记录']) assert.ok(body().includes(value), value);
  assert.equal(document.querySelectorAll('[data-observation-id],img,button').length, 0);
  check('an open pause remains visible with zero observations and creates no evidence or action');
  const closed = {...pause, gap_end_at: '2026-10-03T10:10:30Z', gap_end_known: true};
  await row(closed); assert.match(body(), /5 分钟 30 秒/); assert.match(body(), /空缺结束仅表示接受了新的采样/); assert.ok(!body().includes('空缺仍未关闭'));
  check('closed known gaps show duration bounded by the accepted sample and retain discrete-sampling caveat');
  await feed([], [start, pause]); assert.match(body(), /已启动 · 等待首次采样/); assert.match(body(), /不能据此结束此前空缺/); assert.match(body(), /空缺仍未关闭/);
  await row({...start, first_sample_at: '2026-10-03T10:10:30Z'}); assert.match(body(), /首次接受采样/); assert.match(body(), /不代表连续覆盖/); assert.ok(!body().includes('等待首次采样'));
  check('starting without a sample never closes a gap; first accepted sample is a point rather than continuous coverage');
  for (const gap_end_at of [null, '2026-10-03T11:00:00Z']) {
    await row({...pause, kind: 'process_restarted', occurred_at: '2026-10-03T10:55:00Z',
      gap_started_at: pause.last_sample_at, gap_start_known: false, gap_end_at, gap_end_known: !!gap_end_at});
    for (const value of ['重启发现时间', '实际停止时间未知', '不能计算停机时长', '重启发现时间不代表实际停机时间', '最后已接受采样']) assert.ok(body().includes(value), value);
    assert.ok(!body().includes('分钟'));
  }
  await row({...pause, kind: 'process_restarted', last_sample_at: null, gap_started_at: null, gap_start_known: false}); assert.match(body(), /此前最后采样时间未知/);
  check('restart with or without history, open or sampled later, never fabricates exact shutdown time or downtime');
  for (const event of [
    {...closed, gap_end_at: '2026-10-03T10:00:00Z'}, {...closed, gap_end_at: 'bad'},
    {...closed, gap_started_at: 'bad'}, {...pause, gap_start_known: false, occurred_at: 'bad'},
  ]) {
    await row(event); assert.ok(!body().includes('NaN')); assert.ok(!body().includes('Invalid Date')); assert.ok(!body().includes('分钟'));
  }
  await row({...closed, gap_end_at: 'bad'}); assert.match(body(), /后续采样时间未知/); assert.ok(!body().includes('空缺仍未关闭'));
  check('missing, invalid and inverted boundaries degrade to unknown rather than a made-up duration');
  for (const [kind, text] of [['paused', '采集已暂停'], ['revoked', '录制授权已撤销'], ['reconfigured', '采集范围已更改'], ['stopped', '采集已停止']]) {
    await row({...pause, kind}); assert.ok(body().includes(text));
  }
  await row({...pause, kind: 'stopped', reason: 'configuration_changed'}); assert.match(body(), /配置已更改/); assert.ok(!body().includes('采集失败'));
  for (const reason of ['RAW_PROVIDER_SECRET', '__proto__', 'constructor']) {await row({...pause, reason, source_kind: 'RAW_SOURCE_SECRET'}); assert.ok(!body().includes(reason)); assert.ok(!body().includes('RAW_SOURCE_SECRET'));}
  check('all transition kinds are readable and unknown raw reason/source strings never leak into the UI');
  const tied = [{...pause, id: 'second-durable', kind: 'reconfigured'}, {...pause, id: 'first-durable'}];
  const observations = [{...observation, id: 'same-time', captured_at: pause.occurred_at}, {...observation, id: 'earlier'}, {...observation, id: 'latest', captured_at: start.occurred_at}];
  const snapshot = JSON.stringify({observations, tied});
  assert.deepEqual(captureFeedEntries(observations, tied).map(entry => entry.item.id), ['latest', 'second-durable', 'first-durable', 'same-time', 'earlier']);
  assert.equal(JSON.stringify({observations, tied}), snapshot);
  await feed(observations, tied);
  assert.deepEqual([...document.querySelector('.event-feed').children].map(node => node.getAttribute('data-observation-id') || node.getAttribute('data-coverage-kind')), ['latest', 'reconfigured', 'paused', 'same-time', 'earlier']);
  check('feed interleaves sample and boundary timestamps, preserves durable event ties and never mutates source arrays');
  const attempts = Array.from({length: 8}, (_, i) => ({...start, id: `attempt-${i}`, occurred_at: `2026-10-03T10:${20-i}:00Z`}));
  await feed([], [...attempts, pause], 6); assert.equal(document.querySelectorAll('[data-coverage-kind]').length, 7); assert.match(body(), /采集已暂停/);
  check('recent-entry limit cannot hide the latest still-open gap behind failed start attempts');
  await feed([], [{...pause, id: 'durable-latest', kind: 'revoked', occurred_at: '2026-10-03T09:00:00Z'}, ...attempts, {...pause, id: 'older-open'}], 6);
  assert.ok(document.querySelector('[data-coverage-kind="revoked"]'));
  check('latest open boundary is selected by durable API order even if the wall clock moved backwards');
  await feed([], [closed]); assert.equal(document.querySelectorAll('[data-observation-id]').length, 0); assert.match(body(), /5 分钟 30 秒/);
  check('accepted duplicate samples may close a gap without inventing an observation row');

  // Render the real App feed consumers, not a source-only assertion.
  const app = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');
  const timeline = app.slice(app.indexOf('function UnifiedTimeline()'), app.indexOf('\nfunction ', app.indexOf('function UnifiedTimeline()') + 1));
  const today = app.slice(app.indexOf('function observationProcessingReason('), app.indexOf('function PreviewPrivacy('));
  assert.ok(timeline.includes('setCoverageEvents(result.coverage_events ?? [])'));
  assert.ok(today.includes('setCoverageEvents(nextObservations.coverage_events ?? [])'));
  let response = {items: [], coverage_events: [pause]}, mutationCalls = 0, readCalls = 0;
  const api = {
    getContextObservations: async () => {readCalls++; return response;},
    getContextEngineStatus: async () => ({recording: {active: false, authorized: false, record_count: 0}}),
    pauseBuiltinCaptureApi: async () => {mutationCalls++;}, revokeBuiltinCaptureApi: async () => {mutationCalls++;},
    retryContextObservation: async () => {mutationCalls++;}, deleteContextObservation: async () => {mutationCalls++;},
  };
  const source = `const {useState,useEffect,useRef}=React; const {CaptureObservationFeed}=feed;
    const {getContextObservations,getContextEngineStatus,pauseBuiltinCaptureApi,revokeBuiltinCaptureApi,retryContextObservation,deleteContextObservation}=api;
    const isPreviewDesktop=()=>true,readActivationStatus=()=>"local",capturePauseMessage=()=>"",navigateClient=()=>{},
      CaptureObservationAnalysis=()=>null,CaptureObservationProvenance=()=>null,CaptureSessionSummary=()=>null,
      PreviewDailyReview=()=>null,PreviewModelSettings=()=>null,observationCurrentContent=()=>null,observationStateLabel=()=>"pending";
    ${timeline}\n${today}\nreturn {UnifiedTimeline,PreviewToday};`;
  const components = vm.runInThisContext(`(function(require,React,feed,api,exports){${ts.transpileModule(source, {compilerOptions: options}).outputText}\n})`)(require, React, loaded.exports, api, {});
  for (const Component of [components.UnifiedTimeline, components.PreviewToday]) {
    response = {items: [], coverage_events: [pause]};
    await act(async () => {root.render(React.createElement(Component, {onOpenGuide: () => {}})); await flush();});
    assert.ok(document.querySelector('[data-coverage-kind="paused"]')); assert.equal(document.querySelectorAll('.preview-observation-row:not(.preview-coverage-row)').length, 0);
    response = {items: [observation], coverage_events: [start, closed]};
    await act(async () => {[...document.querySelectorAll('button')].find(node => node.textContent === '刷新').click(); await flush();});
    assert.ok(document.querySelector('[data-coverage-kind="started"]')); assert.match(body(), /5 分钟 30 秒/); assert.match(body(), /等待首次采样/);
    assert.equal(document.querySelectorAll('.preview-observation-row:not(.preview-coverage-row)').length, 1);
    response = {items: [observation]};
    await act(async () => {[...document.querySelectorAll('button')].find(node => node.textContent === '刷新').click(); await flush();});
    assert.equal(document.querySelectorAll('[data-coverage-kind]').length, 0); assert.match(body(), /旧版记录可能缺少/);
    await act(async () => root.render(null));
  }
  assert.equal(readCalls, 6); assert.equal(mutationCalls, 0);
  check('real Timeline and Today render empty-sample pauses, refresh to sample boundaries, support old APIs and perform only reads');
  await act(async () => root.unmount()); dom.window.close();
  console.log(JSON.stringify({suite: 'capture-coverage-dom', passed: checks.length, checks, rendered_browser: false, real_capture_or_model_called: false}, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1; dom.window.close();});
