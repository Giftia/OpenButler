import type {ContextObservation, OcrSourceGrounding, OcrSourceSpan} from "../lib/api";

const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string"
  && value.trim().length > 0 && Array.from(value).length <= maximum;
const offsets = (start: unknown, end: unknown, quote: string) => typeof start === "number" && typeof end === "number"
  && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end <= 2000
  && end > start && end - start === Array.from(quote).length;

export function observationSourceGrounding(item: ContextObservation): OcrSourceGrounding | null {
  const facts = item.current_facts;
  const grounding = facts?.source_grounding;
  if (item.extraction_version !== 2 || facts?.version !== 2 || facts.inference !== true
    || facts.input_scope !== "current_observation_only" || !grounding || grounding.version !== 1 || grounding.source_kind !== "post_mask_ocr_text"
    || facts?.observation_route !== "post_mask_ocr_to_text_model"
    || grounding.verification !== "exact_source_spans_only" || grounding.semantic_verified !== false
    || grounding.offset_unit !== "unicode_codepoints" || !digest(grounding.source_text_digest)
    || !text(grounding.observation_id, 100) || grounding.observation_id !== facts.observation_id || grounding.observation_id !== item.id
    || grounding.evidence_id !== facts.evidence_id || grounding.image_digest !== facts.image_digest
    || !text(grounding.evidence_id, 100) || !digest(grounding.image_digest)
    || (item.evidence_available === true && grounding.evidence_id !== item.evidence_id)
    || (item.ocr_provenance && grounding.image_digest !== item.ocr_provenance.image_digest)
    || !Array.isArray(grounding.excerpts) || grounding.excerpts.length < 1 || grounding.excerpts.length > 3
    || !grounding.excerpts.every((span) => span && text(span.quote, 120) && offsets(span.start, span.end, span.quote))
    || grounding.excerpts.reduce((length, span) => length + Array.from(span.quote).length, 0) > 200
    || new Set(grounding.excerpts.map((span) => span.quote)).size !== grounding.excerpts.length
    || grounding.model_proposal?.verification !== "unverified_inference"
    || !text(grounding.model_proposal.title, 100) || !text(grounding.model_proposal.summary, 500)) return null;
  // Full OCR is intentionally absent from this API. Check the host's contract
  // and canonical aliases, without claiming client-side source verification.
  const summary = `屏幕文档 OCR 文字：“${grounding.excerpts.map((span) => span.quote).join("”；“")}”。`;
  return facts.title === "文档 OCR 摘录" && facts.summary === summary
    && item.title === facts.title && item.summary === facts.summary ? grounding : null;
}

function sourceSpanValid(span: OcrSourceSpan | undefined, quote: string, observationId: string): span is OcrSourceSpan {
  return !!span && text(span.observation_id, 100) && span.observation_id === observationId && text(span.evidence_id, 100)
    && digest(span.image_digest) && digest(span.source_text_digest) && span.offset_unit === "unicode_codepoints"
    && text(quote, 120) && offsets(span.start, span.end, quote);
}

function currentSpanMatches(span: OcrSourceSpan, quote: string, grounding: OcrSourceGrounding) {
  return span.evidence_id === grounding.evidence_id && span.image_digest === grounding.image_digest
    && span.source_text_digest === grounding.source_text_digest && grounding.excerpts.some((excerpt) =>
      span.start >= excerpt.start && span.end <= excerpt.end
      && Array.from(excerpt.quote).slice(span.start - excerpt.start, span.end - excerpt.start).join("") === quote);
}

function SpanTrace({span}: {span: OcrSourceSpan}) {
  return <small>来源记录 {span.observation_id} · 图片依据 ID {span.evidence_id} · 图片 SHA-256 {span.image_digest}
    {` · OCR 文本 SHA-256 ${span.source_text_digest} · Unicode 码点 [${span.start}, ${span.end})`}</small>;
}

export function observationStateLabel(state: ContextObservation["state"]) {
  return {recorded_pending: "已记录，待整理", processing: "整理中",
    ready: "处理完成 · 未核实", model_unavailable: "整理失败，记录仍在本机"}[state];
}

export function observationCurrentContent(item: ContextObservation) {
  // Legacy summaries may have used historical context. Never relabel them as
  // isolated current-frame extraction or substitute an association conclusion.
  if (item.extraction_version !== 2) return item;
  const facts = item.current_facts;
  // An advertised but invalid contract must not fall back to model prose.
  if (facts && Object.prototype.hasOwnProperty.call(facts, "source_grounding") && !observationSourceGrounding(item)) return null;
  return facts?.version === 2 && facts.inference === true && facts.input_scope === "current_observation_only"
    && [facts.title, facts.summary, facts.boundary, facts.observation_id, facts.evidence_id, facts.captured_at]
      .every((value) => typeof value === "string" && value.trim().length > 0)
    && typeof facts.image_digest === "string" && /^[0-9a-f]{64}$/.test(facts.image_digest)
    && ["post_mask_ocr_to_text_model", "masked_image_to_vision_to_text"].includes(facts.observation_route)
    ? facts : null;
}

export function associationReasonLabel(reason?: string | null) {
  const labels: Record<string, string> = {
    no_prior_records: "没有可用于关联的历史记录。",
    no_source_grounded_prior: "历史记录没有可用的原始 OCR 摘录，未用模型摘要代替来源。",
    no_prior_within_budget: "历史记录未能在本次输入上限内纳入，不推断跨记录关系。",
    invalid_association_result: "关联的引用或格式未通过检查，没有采用关联结论。",
    invalid_source_grounding: "OCR 原文片段或来源信息未通过检查，没有采用关联结论。",
    current_facts_changed: "当前画面观察已改变，没有采用与旧观察关联的结果。",
    prompt_limit_exceeded: "历史关联输入超过处理上限，没有截断或生成关联结论。",
    invalid_temporal_comparison: "关联的引用或格式未通过检查，没有采用关联结论。",
    invalid_model_result: "关联模型返回格式未通过检查，没有采用关联结论。",
    model_unavailable: "关联模型暂不可用，没有采用关联结论。",
    provider_connection_failed: "无法连接关联模型服务，没有采用关联结论。",
    provider_http_error: "关联模型服务返回错误，没有采用关联结论。",
    temporal_context_changed: "历史依据已改变，没有采用旧的关联结论。",
    evidence_changed: "关联依据已改变，没有采用关联结论。",
    capture_paused: "采集已暂停，历史关联未继续。",
    authorization_revoked: "授权已撤销，历史关联已停止。",
    source_reconfigured: "采集来源已改变，历史关联未继续。",
    session_expired: "本次授权已到期，历史关联未继续。",
    process_restarted: "服务重启中断了历史关联。",
  };
  return reason && Object.prototype.hasOwnProperty.call(labels, reason) ? labels[reason]
    : reason ? "关联原因暂不可确认，没有可采用的变化结论。" : "";
}

export function CaptureObservationAnalysis({item}: {item: ContextObservation}) {
  const isolated = item.extraction_version === 2;
  const content = observationCurrentContent(item);
  const grounding = content ? observationSourceGrounding(item) : null;
  const legacyOcr = isolated && content && item.current_facts?.observation_route === "post_mask_ocr_to_text_model" && !grounding;
  const temporal = item.temporal_context;
  const priorIds = Array.isArray(temporal?.prior_observation_ids)
    && temporal.prior_observation_ids.every((id) => typeof id === "string") ? temporal.prior_observation_ids : null;
  const priorLabel = priorIds === null ? "未知（引用信息缺失）" : priorIds.length ? priorIds.join("、") : "无";
  const completeRelations = !!content && priorIds !== null && priorIds.length > 0
    && (temporal?.citation_basis !== "post_mask_ocr_spans" || !!grounding)
    && Array.isArray(temporal?.relations) && temporal.relations.length > 0 && temporal.relations.every((relation) =>
    relation && typeof relation.prior_observation_id === "string" && priorIds.includes(relation.prior_observation_id)
    && ["same_topic", "different_topic", "uncertain"].includes(relation.relation)
    && typeof relation.current_quote === "string" && relation.current_quote.trim().length > 0
    && typeof relation.prior_quote === "string" && relation.prior_quote.trim().length > 0
    && (!grounding || (temporal?.citation_basis === "post_mask_ocr_spans"
      && sourceSpanValid(relation.current_source_span, relation.current_quote, grounding.observation_id)
      && currentSpanMatches(relation.current_source_span, relation.current_quote, grounding)
      && sourceSpanValid(relation.prior_source_span, relation.prior_quote, relation.prior_observation_id))));
  const relations = completeRelations && Array.isArray(temporal?.relations) ? temporal.relations : [];
  const state = temporal?.association_state;
  const states = {skipped: "已跳过", pending: "等待处理", running: "处理中", ready: "处理完成 · 仍为推断", failed: "失败"};
  const stateLabel = state === "ready" && !completeRelations ? "结果不完整 · 未采用"
    : state && Object.prototype.hasOwnProperty.call(states, state) ? states[state] : "状态未知";
  const relationLabels = {same_topic: "可能为同一主题", different_topic: "可能为不同主题", uncertain: "无法确定关系"};
  return <>
    <div className="preview-observation-inference" aria-label="画面观察与推断">
      <small>{content?.summary ? grounding ? "当前文档 OCR 原文摘录 · 语义未核实"
        : legacyOcr ? "旧版当前 OCR 模型推断 · 无原文片段校验"
        : isolated ? "当前画面 AI 观察 · 未核实" : "旧版 AI 整理推断 · 待核实" : "整理状态 · 尚无结论"}</small>
      <p>{content?.summary || (item.state === "model_unavailable" ? "当前画面整理不可用；本机记录仍保留，未生成结论。" : "已保存遮挡后画面，尚未生成整理结论。")}</p>
      {grounding && <div aria-label="OCR 原文片段与来源">
        <small>这里只校验摘录与已保存 OCR 原文的对应关系。OCR 可能识别错误；文字不证明画面中存在实物、真实操作、远程状态或任务完成。</small>
        <small>{item.evidence_available === true ? "截图依据是否可打开仍以查看结果为准。" : "截图依据已过期、不可用或状态未知，以下仅为保留的来源信息。"}</small>
        {grounding.excerpts.map((span) => <div key={`${span.start}-${span.end}`}>
          <p style={{whiteSpace: "pre-wrap"}}>OCR 原文：“{span.quote}”</p>
          <SpanTrace span={{...span, observation_id: grounding.observation_id, evidence_id: grounding.evidence_id,
            image_digest: grounding.image_digest, source_text_digest: grounding.source_text_digest, offset_unit: grounding.offset_unit}} />
        </div>)}
        <details aria-label="未核实的模型解释">
          <summary>展开模型解释（未核实，不能作为来源证据）</summary>
          <small>以下是模型自由推断，可能臆测实物或操作；未用于原文摘录或历史关联的引用。</small>
          <p>{grounding.model_proposal.title}</p><p>{grounding.model_proposal.summary}</p>
        </details>
      </div>}
      {isolated && content && item.current_facts && !grounding && <small>仅以本帧输入生成，仍可能误读文档；不证明真实操作、远程状态或任务完成。本帧 ID {item.current_facts.observation_id} · 图片依据 ID {item.current_facts.evidence_id}</small>}
      {legacyOcr && <small>此记录未保存新版原文片段校验，不能将模型文字视为原始 OCR 证据。</small>}
      {isolated && item.current_facts && !content && <small>当前画面观察信息不完整，不能采用其中的内容或来源声明。</small>}
      {!isolated && <small>旧版记录可能混合历史上下文，未经过当前画面隔离提取，不能视为已修正。</small>}
    </div>
    {isolated && <div className="preview-observation-provenance" aria-label="独立历史关联">
      <small role="status">历史关联：{stateLabel}。当前画面观察与关联结果分开保留。</small>
      {temporal?.association_reason && <small>{associationReasonLabel(temporal.association_reason)}</small>}
      {state === "failed" && <small>历史关联失败；当前画面观察仍保留，未被失败结果覆盖。</small>}
      {state === "skipped" && <small>没有进行历史关联，不据此推断跨记录变化。</small>}
      {typeof temporal?.prior_selected_count === "number" && <>
        <small>历史候选 {temporal.prior_candidate_count ?? "未知"} 条 · 本次纳入 {temporal.prior_selected_count} 条 · 省略 {temporal.prior_omitted_count ?? "未知"} 条</small>
        <small>纳入的历史记录：{priorLabel}。省略的观察点没有参与本次关联。</small>
      </>}
      {state === "ready" && !completeRelations && <small>关联引用信息缺失或格式不完整，没有可展示的历史关系，不能推断活动变化。</small>}
      {state === "ready" && completeRelations && <>
        <small>关联为未核实的模型推断；引文匹配不等于关系已证实，也不能补全未采样活动。</small>
        {relations.length ? relations.map((relation, index) => <div key={`${relation.prior_observation_id}-${index}`}>
          <small>{Object.prototype.hasOwnProperty.call(relationLabels, relation.relation) ? relationLabels[relation.relation] : "关系未知"} · 历史记录 {relation.prior_observation_id}</small>
          <small>{grounding ? "当前 OCR 原文引文" : "当前观察引文"}：{relation.current_quote}</small>
          <small>{grounding ? "历史 OCR 原文引文" : "历史观察引文"}：{relation.prior_quote}</small>
          {grounding && relation.current_source_span && <SpanTrace span={relation.current_source_span} />}
          {grounding && relation.prior_source_span && <SpanTrace span={relation.prior_source_span} />}
        </div>) : <small>没有可展示的历史关系，不能推断活动变化。</small>}
      </>}
    </div>}
    {!isolated && temporal && <div className="preview-observation-provenance" aria-label="旧版历史上下文">
      <small>旧版历史上下文：{temporal.note || "属于旧版推断，不能作为当前画面独立观察。"}</small>
      <small>旧版引用记录：{priorLabel}。这不是新版独立关联结果。</small>
    </div>}
  </>;
}
