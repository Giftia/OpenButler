'use strict';
// Synthetic React/JSDOM only: no captures, model requests or network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), {JSDOM} = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
for (const key of ['window', 'document', 'HTMLElement']) global[key] = dom.window[key];
Object.defineProperty(global, 'navigator', {value: dom.window.navigator, configurable: true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), {act} = React, {createRoot} = require('react-dom/client');
const file = path.resolve(__dirname, '../src/components/CaptureObservationAnalysis.tsx');
const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText;
const loaded = {exports: {}};
vm.runInThisContext(`(function(require,module,exports){${output}\n})`, {filename:file})(require, loaded, loaded.exports);
const {CaptureObservationAnalysis, observationCurrentContent, observationStateLabel, associationReasonLabel} = loaded.exports;
const root = createRoot(document.getElementById('root'));
const checks = [], check = name => checks.push(name);
const current = {version:2, inference:true, input_scope:'current_observation_only', observation_id:'current-frame-id', evidence_id:'same-owned-image-id', image_digest:'a'.repeat(64), captured_at:'2026-10-02T10:00:00Z', observation_route:'post_mask_ocr_to_text_model', title:'当前公开文档', summary:'本帧文档显示公开文本。', boundary:'未核实的当前画面推断'};
const base = {id:current.observation_id, evidence_id:current.evidence_id, state:'ready', extraction_version:2, current_facts:current, title:'COMPATIBILITY TITLE', summary:'COMPATIBILITY SUMMARY MUST NOT OVERRIDE CURRENT', temporal_context:{association_state:'skipped', association_reason:'no_prior_records', inference:true, coverage:'discrete_samples_only', prior_observation_ids:[], prior_candidate_count:0, prior_selected_count:0, prior_omitted_count:0, relations:[]}};
async function render(item) { await act(async()=>root.render(React.createElement(CaptureObservationAnalysis,{item}))); }
function body() { return document.body.textContent; }
function summary() { return document.querySelector('[aria-label="画面观察与推断"] p')?.textContent; }
(async()=>{
  await render(base);
  assert.equal(summary(), current.summary);assert.equal(observationCurrentContent(base).title, current.title);
  for(const text of ['当前画面 AI 观察 · 未核实','仅以本帧输入生成','不证明真实操作','current-frame-id','same-owned-image-id','历史关联：已跳过','没有可用于关联的历史记录']) assert.ok(body().includes(text), text);
  assert.ok(!body().includes('COMPATIBILITY SUMMARY'));
  assert.match(observationStateLabel('ready'),/处理完成.*未核实/);
  check('version2 renders immutable current facts and original frame/evidence IDs, with explicit unverified processing and skipped association');
  for (const state of ['pending','running','failed']) {
    await render({...base,temporal_context:{...base.temporal_context,association_state:state,association_reason:state==='failed'?'invalid_association_result':null,relations:[{prior_observation_id:'stale-prior',relation:'same_topic',current_quote:'UNACCEPTED CURRENT',prior_quote:'UNACCEPTED PRIOR'}]}});
    assert.equal(summary(), current.summary);assert.ok(!body().includes('UNACCEPTED CURRENT'));assert.ok(!body().includes('UNACCEPTED PRIOR'));
    assert.match(body(),state==='pending'?/历史关联：等待处理/:state==='running'?/历史关联：处理中/:/历史关联：失败/);
    if(state==='failed'){assert.match(body(),/未被失败结果覆盖/);assert.match(body(),/引用或格式未通过检查/);}
  }
  check('pending/running/failed association remains separate and never replaces current summary or displays rejected relation citations');
  const ready = {...base,temporal_context:{...base.temporal_context,association_state:'ready',association_reason:null,prior_observation_ids:['prior-record-id'],prior_candidate_count:3,prior_selected_count:1,prior_omitted_count:2,relations:[{prior_observation_id:'prior-record-id',relation:'same_topic',current_quote:'公开文本',prior_quote:'先前文档内容'}]}};
  await render(ready);assert.equal(summary(),current.summary);
  for(const text of ['处理完成 · 仍为推断','引文匹配不等于关系已证实','历史候选 3 条','本次纳入 1 条','省略 2 条','可能为同一主题','历史记录 prior-record-id','当前观察引文：公开文本','历史观察引文：先前文档内容'])assert.ok(body().includes(text),text);
  check('ready association exposes independent inference, selected/omitted coverage and exact prior/current citation text');
  await render({...ready,temporal_context:{...ready.temporal_context,relations:[]}});assert.match(body(),/没有可展示的历史关系/);assert.equal(summary(),current.summary);
  check('ready with no relations does not manufacture a change');
  for (const extraction_version of [undefined,1]) {
    await render({...base,extraction_version,current_facts:null,title:'旧标题',summary:'旧版混合历史摘要',temporal_context:{prior_observation_ids:['legacy-id'],note:'旧版历史推断'}});
    assert.equal(summary(),'旧版混合历史摘要');assert.match(body(),/旧版 AI 整理推断/);assert.match(body(),/不能视为已修正/);assert.match(body(),/旧版引用记录：legacy-id/);
    assert.ok(!body().includes('仅以本帧输入生成'));assert.equal(document.querySelector('[aria-label="独立历史关联"]'),null);
  }
  check('legacy and missing version rows remain historical inference and are never relabeled current-only or fixed');
  await render({...base,state:'processing',current_facts:null});assert.match(body(),/尚无结论/);assert.ok(!body().includes('COMPATIBILITY SUMMARY'));assert.equal(summary(),'已保存遮挡后画面，尚未生成整理结论。');
  check('version2 pending extraction never falls back to a stale compatibility summary');
  for(const reason of ['RAW_PROVIDER_SECRET','__proto__','constructor']) {await render({...base,temporal_context:{...base.temporal_context,association_state:'failed',association_reason:reason}});assert.ok(!body().includes(reason));assert.equal(typeof associationReasonLabel(reason),'string');}
  assert.match(associationReasonLabel('no_prior_within_budget'),/输入上限/);assert.match(associationReasonLabel('current_facts_changed'),/当前画面观察已改变/);
  check('association failure codes use fixed actionable labels and never echo arbitrary provider output');
  await render({...base,temporal_context:undefined});assert.match(body(),/历史关联：状态未知/);assert.equal(summary(),current.summary);
  check('missing association metadata is visibly unknown rather than success');
  // Real native failure rows can carry temporal_context: {} with no prior IDs.
  for (const metadata of [{}, null, undefined, {note:null}, {prior_observation_ids:null}, {prior_observation_ids:[]}]) {
    for (const state of ['model_unavailable','recorded_pending']) {
      await render({...base,extraction_version:1,current_facts:null,state,title:null,summary:null,temporal_context:metadata});
      assert.match(body(),/尚无结论/);assert.ok(!body().includes('本帧文档显示公开文本'));assert.ok(!body().includes('处理完成 · 仍为推断'));
      assert.equal(document.querySelector('[aria-label="独立历史关联"]'),null);
      if(metadata && !Array.isArray(metadata.prior_observation_ids))assert.match(body(),/引用信息缺失/);
    }
  }
  check('actual legacy failure/pending rows with empty, partial or null temporal metadata render without inventing facts or relations');
  for (const metadata of [{},null,{association_state:'ready',prior_selected_count:1},{association_state:'ready',prior_selected_count:1,prior_observation_ids:null,relations:null},{association_state:'ready',prior_selected_count:1,prior_observation_ids:{},relations:[null,{}, {prior_observation_id:'INCOMPLETE_CITATION'}]}]) {
    await render({...base,temporal_context:metadata});assert.equal(summary(),current.summary);
    assert.ok(!body().includes('INCOMPLETE_CITATION'));assert.ok(!body().includes('可能为同一主题'));
    if(metadata?.association_state==='ready'){assert.match(body(),/没有可展示的历史关系/);assert.match(body(),/引用信息缺失/);}
    else assert.match(body(),/历史关联：状态未知/);
  }
  check('version2 partial/null metadata and malformed relation arrays preserve current facts and display missing citations safely');
  for(const facts of [null,{}, {version:2}, {...current,observation_id:undefined}, {...current,evidence_id:null}, {...current,summary:''}, {...current,image_digest:undefined}]) {
    await render({...base,current_facts:facts});assert.equal(observationCurrentContent({...base,current_facts:facts}),null);
    assert.ok(!body().includes('仅以本帧输入生成'));assert.ok(!body().includes('本帧文档显示公开文本'));assert.ok(!body().includes('COMPATIBILITY SUMMARY'));
    if(facts)assert.match(body(),/当前画面观察信息不完整/);
  }
  check('partial current-facts metadata never claims isolated extraction provenance or falls back to another summary');
  for(const relations of [undefined,null,{},[],[null],[{}],[{prior_observation_id:'prior-record-id',relation:'same_topic'}]]) {
    await render({...ready,temporal_context:{...ready.temporal_context,relations}});assert.equal(summary(),current.summary);
    assert.match(body(),/历史关联：结果不完整 · 未采用/);assert.ok(!body().includes('历史关联：处理完成'));assert.ok(!body().includes('可能为同一主题'));
  }
  check('ready with absent or malformed relations is visibly incomplete and never claims completed association');
  for(const malformed of [{...ready,current_facts:null},{...ready,current_facts:{}},{...ready,temporal_context:{...ready.temporal_context,prior_observation_ids:[],relations:[]}}]) {
    await render(malformed);assert.match(body(),/历史关联：结果不完整 · 未采用/);assert.ok(!body().includes('历史关联：处理完成'));assert.ok(!body().includes('可能为同一主题'));
  }
  check('completed association requires current facts and nonempty valid prior and relation arrays');



  const app = fs.readFileSync(path.resolve(__dirname,'../src/App.tsx'),'utf8');
  assert.match(app,/<CaptureObservationAnalysis item=\{item\} \/>/);assert.match(app,/observationCurrentContent\(item\)\?\.title/);assert.ok(!app.includes('item.temporal_context.comparison?.performed'));
  check('timeline row uses isolated current title and the separate association component');
  await act(async()=>root.unmount());dom.window.close();console.log(JSON.stringify({suite:'observation-analysis-dom',passed:checks.length,checks,rendered_browser:false},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;dom.window.close();});
