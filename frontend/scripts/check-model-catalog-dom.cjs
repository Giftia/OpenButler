'use strict';
// Real component, synthetic IPC only. No provider requests, model transfer or inference.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), {JSDOM} = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url:'http://localhost/models'});
for (const name of ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent']) global[name] = dom.window[name];
Object.defineProperty(global,'navigator',{value:dom.window.navigator,configurable:true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), {act} = React, {createRoot} = require('react-dom/client');
const cache = new Map();
function load(filename) {
  if (filename.endsWith('.css')) return {};
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = {exports:{}}; cache.set(filename,module);
  const compiled = ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`,{filename})((name)=> {
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(path.dirname(filename),name);
    return load([base,base+'.ts',base+'.tsx'].find(file=>fs.existsSync(file)));
  },module,module.exports); return module.exports;
}
const {ModelCatalog} = load(path.resolve(__dirname,'../src/components/ModelCatalog.tsx'));
const helpers = load(path.resolve(__dirname,'../src/lib/modelCatalog.ts'));
const clone = value => JSON.parse(JSON.stringify(value));
const catalog = [
  {id:'vision-small',name:'Vision Small',backend:'ollama',model:'vision-small:3b',manifestDigest:'sha256:'+'a'.repeat(64),downloadBytes:3000000000,roles:['image'],quantization:'Q4_K_M',license:{name:'Apache 2.0',url:'https://www.apache.org/licenses/LICENSE-2.0'},sourceUrl:'https://ollama.com/library/vision-small',notes:['Synthetic test metadata'],assets:[{digest:'sha256:'+'b'.repeat(64),size:3000000000,mediaType:'application/octet-stream'}],downloadSupported:true},
  {id:'vision-alt',name:'Vision Alternate',backend:'ollama',model:'vision-alt:e2b',manifestDigest:'sha256:'+'c'.repeat(64),downloadBytes:4300000000,roles:['image'],quantization:'Q4_0',license:{name:'Apache 2.0',url:'https://www.apache.org/licenses/LICENSE-2.0'},sourceUrl:'https://ollama.com/library/vision-alt',notes:[],assets:[],downloadSupported:true},
  {id:'text-small',name:'Text Small',backend:'ollama',model:'text-small:4b',manifestDigest:'sha256:'+'d'.repeat(64),downloadBytes:2500000000,roles:['text'],quantization:'Q4_K_M',license:{name:'Apache 2.0',url:'https://www.apache.org/licenses/LICENSE-2.0'},sourceUrl:'https://ollama.com/library/text-small',notes:[],assets:[],downloadSupported:true},
];
let root, calls, picks, opens, inspectionHandler, downloadHandler, cancelHandler, statusHandler, latestJob, intervals;
const deferred = () => { let resolve,reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush = () => new Promise(resolve=>setImmediate(resolve));
const endpoint = 'http://127.0.0.1:11434';
function inspection(target=endpoint, installed=false) { return {ok:true,inspectionId:'inspection-fixture',endpoint:target,runtime:{available:true,version:'0.20.0',hostRelation:'unknown',hardwareVerified:false},device:{platform:'linux',arch:'x64',memoryBytes:8589934592,memorySource:'cgroup_v2',availableMemoryBytes:6000000000,cpuCount:4,gpu:'unknown',scope:'desktop_process'},entries:catalog.map(entry=>({id:entry.id,installed,digestMatches:installed,imageMetadataVerified:installed,fit:'unknown'}))}; }
function job(overrides={}) { return {id:'job-fixture',catalogId:'vision-small',endpoint,model:'vision-small:3b',manifestDigest:catalog[0].manifestDigest,state:'downloading',phase:'pulling',completedBytes:1260000000,totalBytes:3000000000,serverState:'active',canRetry:false,updatedAt:'2026-10-02T14:00:00Z',...overrides}; }
function bridge() { return {
 getBuiltinModelCatalog: async()=>{calls.push(['catalog']);return{ok:true,catalogVersion:'fixture',entries:clone(catalog)};},
 getBuiltinModelDownload: async(input)=>{calls.push(['status',input]);return statusHandler?statusHandler(input):{ok:true,job:clone(latestJob)};},
 inspectBuiltinModelHost: async(input)=>{calls.push(['inspect',clone(input)]);return inspectionHandler?inspectionHandler(input):inspection(input.endpoint);},
 startBuiltinModelDownload: async(input)=>{calls.push(['download',clone(input)]);if(downloadHandler)return downloadHandler(input);latestJob=job();return{ok:true,job:clone(latestJob)};},
 cancelBuiltinModelDownload: async(input)=>{calls.push(['cancel',clone(input)]);if(cancelHandler)return cancelHandler(input);latestJob=job({state:'interrupted',serverState:'unknown'});return{ok:true,job:clone(latestJob)};},
}; }
async function unmount() { if (root) { await act(async()=>{root.unmount();await flush();}); root=null; } }
async function reset({installed=false,snapshot=null,missing=false}={}) {
 await unmount(); calls=[];picks=[];opens=0;inspectionHandler=installed?async({endpoint})=>inspection(endpoint,true):null;downloadHandler=null;cancelHandler=null;statusHandler=null;latestJob=snapshot;intervals=new Map();
 window.setInterval=(fn)=>{const id=intervals.size+1;intervals.set(id,fn);return id;};window.clearInterval=id=>intervals.delete(id);
 const api=missing?{}:bridge(); root=createRoot(document.getElementById('root'));
 await act(async()=>{root.render(React.createElement(ModelCatalog,{bridge:api,assignments:{image:'',text:'',status:'待测试'},onPick:(...args)=>picks.push(args),onOpenAdvanced:()=>opens++}));await flush();});
}
function button(text,exact=true) { const result=[...document.querySelectorAll('button')].find(item=>exact?(item.textContent.trim()===text||item.getAttribute('aria-label')===text):item.textContent.includes(text));assert.ok(result,`Missing ${text}`);return result; }
function buttons(text) { return [...document.querySelectorAll('button')].filter(item=>item.textContent.trim()===text); }
async function click(text,exact=true) { await act(async()=>{button(text,exact).click();await flush();}); }
async function change(value) { await act(async()=>{const input=document.querySelector('[data-testid="catalog-endpoint"]');assert.ok(input);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));await flush();}); }
async function tick() { await act(async()=>{for(const fn of [...intervals.values()])await fn();await flush();}); }
const checks=[];const check=name=>checks.push(name);
(async()=>{
 await reset();assert.deepEqual(calls.map(x=>x[0]),['catalog','status']);assert.equal(buttons('下载').length,2);assert.ok(buttons('下载').every(x=>x.disabled));assert.match(document.body.textContent,/未检测/);assert.match(document.body.textContent,/内存待测/);assert.match(document.body.textContent,/未实测/);assert.equal(picks.length,0);check('mount only reads bundled catalog and local journal; no runtime probing or automatic download/activation');
 await click('检测连接');assert.equal(calls.filter(x=>x[0]==='inspect').length,1);assert.deepEqual(calls.find(x=>x[0]==='inspect')[1],{endpoint,protocol:'ollama_native'});assert.match(document.body.textContent,/服务端配置未知/);assert.match(document.body.textContent,/容器限制/);assert.match(document.body.textContent,/不代表模型运行设备/);assert.equal(button('下载').disabled,false);check('explicit inspection binds exact endpoint; cgroup desktop resources never presented as inference-host fit');
 const pending=deferred();downloadHandler=()=>pending.promise;await act(async()=>{button('下载').click();button('下载').click();await flush();});assert.equal(calls.filter(x=>x[0]==='download').length,1);assert.deepEqual(calls.find(x=>x[0]==='download')[1],{inspectionId:'inspection-fixture',catalogId:'vision-small',downloadConsent:true});await act(async()=>{latestJob=job();pending.resolve({ok:true,job:latestJob});await flush();});assert.equal(picks.length,0);assert.match(document.body.textContent,/42%/);assert.equal(document.querySelector('progress').value,42);assert.equal(button('更换服务').disabled,true);assert.match(document.body.textContent,/离开页面会继续下载/);check('same-tick clicks start one selected immutable catalog transfer; real numeric progress and background semantics visible');
 latestJob=job({state:'verifying',completedBytes:3000000000});await tick();assert.match(document.body.textContent,/校验中/);assert.equal(picks.length,0);latestJob=job({state:'succeeded',completedBytes:3000000000,serverState:'terminal'});await tick();assert.match(document.body.textContent,/已下载，待测试/);assert.equal(picks.length,0);await click('填入图像理解配置');assert.deepEqual(picks, [['image',endpoint,'vision-small:3b']]);assert.match(document.body.textContent,/草稿/);assert.equal(calls.filter(x=>x[0]==='download').length,1);check('download and metadata verification never imply inference quality or activation; explicit pick only creates role draft');
 await click('文字整理');assert.match(document.body.textContent,/Text Small/);assert.ok(!document.querySelector('.catalog-candidates').textContent.includes('Vision Small'));check('image and text lists are role-specific; text-only candidates never appear under image');
 await reset();await click('检测连接');await click('更换服务');await change('http://127.0.0.1:11435');assert.ok(buttons('下载').every(x=>x.disabled));await click('检测连接');assert.equal(calls.filter(x=>x[0]==='inspect').at(-1)[1].endpoint,'http://127.0.0.1:11435');check('editing service invalidates inspection and download consent until a new explicit check');
 await reset({snapshot:job()});assert.match(document.body.textContent,/42%/);assert.deepEqual(calls.map(x=>x[0]),['catalog','status']);await click('断开下载');assert.equal(calls.filter(x=>x[0]==='cancel').length,1);assert.match(document.body.textContent,/停止状态未确认/);assert.match(document.body.textContent,/是否停止下载尚未确认/);assert.equal(buttons('重试下载').length,0);await click('检测连接');assert.ok(buttons('下载').every(x=>x.disabled));check('remount reads existing transfer; disconnect remains server-unknown and neither inspect nor UI retries clear lock');
 await reset({snapshot:job()});const stalePoll=deferred();statusHandler=()=>stalePoll.promise;await act(async()=>{const polling=[...intervals.values()][0]();await flush();button('断开下载').click();await flush();stalePoll.resolve({ok:true,job:job()});await polling;await flush();});assert.match(document.body.textContent,/停止状态未确认/);assert.equal(buttons('断开下载').length,0);check('late polling snapshot cannot overwrite a newer disconnect result');
 await reset({snapshot:job({state:'failed',serverState:'terminal',canRetry:true,error_code:'digest_mismatch'})});await click('检测连接');await click('重试下载');assert.equal(calls.filter(x=>x[0]==='download').length,1);check('only server-terminal retryable failures offer explicit retry');
 await reset();await click('检测连接');downloadHandler=async()=>{throw new Error('IPC failed');};await click('下载');assert.match(document.body.textContent,/结果未确认/);assert.ok(buttons('下载').every(x=>x.disabled));latestJob=job();await click('刷新下载状态');assert.match(document.body.textContent,/42%/);check('lost start acknowledgement blocks duplicate request until local journal reconciliation');
 await reset({installed:true});await click('检测连接');await click('已安装');assert.match(document.body.textContent,/Vision Small/);assert.equal(buttons('填入配置').length,2);await click('填入配置');assert.equal(picks.length,1);await click('详情');assert.match(document.body.textContent,/精确版本/);assert.match(document.body.textContent,/Apache 2.0/);assert.match(document.body.textContent,/文件大小不等于运行内存/);await click('关闭版本详情');assert.equal(document.querySelector('.catalog-detail'),null);check('installed metadata enables draft selection only; detail disclosure carries version, license, file evidence and uncertainty');
 await reset();const stale=deferred();inspectionHandler=()=>stale.promise;await click('检测连接');await unmount();await act(async()=>{stale.resolve(inspection());await flush();});assert.equal(picks.length,0);check('closing the view ignores late inspection without mutation or assignment');
 await reset({snapshot:job({state:'succeeded',serverState:'terminal',completedBytes:3000000000})});assert.equal(buttons('填入配置').length,0);await click('检测连接');assert.equal(buttons('填入配置').length,0);assert.equal(button('下载').disabled,false);inspectionHandler=async()=>{throw new Error('offline');};await click('更换服务');await click('检测连接');assert.equal(buttons('填入配置').length,0);check('historical download receipts never override missing metadata or a later failed inspection');
 await reset({missing:true});assert.match(document.body.textContent,/请在桌面版/);assert.equal(calls.length,0);await click('高级设置');assert.equal(opens,1);check('missing desktop API fails visibly and preserves manual settings entry');
 assert.equal(helpers.trustedCatalogLink('javascript:alert(1)'),undefined);assert.equal(helpers.trustedCatalogLink('https://evil.example/model'),undefined);assert.equal(helpers.trustedCatalogLink('https://user@ollama.com/model'),undefined);assert.equal(helpers.modelCatalogError('__proto__'),'操作未完成，请检查服务后重试');assert.equal(helpers.validDownloadJob(job({completedBytes:Infinity})),false);assert.equal(helpers.validDownloadJob(job({state:'cancelled'})),false);check('untrusted links, malformed status and prototype error codes fail closed');
 await unmount();dom.window.close();console.log(JSON.stringify({suite:'model-catalog-dom',passed:checks.length,checks,real_model_called:false,model_downloaded:false,native_desktop:false},null,2));
})().catch(async error=>{console.error(error);try{await unmount();}catch{}dom.window.close();process.exitCode=1;});
