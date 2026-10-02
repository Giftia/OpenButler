import type {ContextObservation} from "../lib/api";

export function observationStateLabel(state: ContextObservation["state"]) {
  return {recorded_pending: "已记录，待整理", processing: "整理中",
    ready: "处理完成 · 未核实", model_unavailable: "整理失败，记录仍在本机"}[state];
}

export function observationCurrentContent(item: ContextObservation) {
  // Legacy summaries may have used historical context. Never relabel them as
  // isolated current-frame extraction or substitute an association conclusion.
  if (item.extraction_version !== 2) return item;
  const facts = item.current_facts;
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
    no_prior_within_budget: "历史记录未能在本次输入上限内纳入，不推断跨记录关系。",
    invalid_association_result: "关联的引用或格式未通过检查，没有采用关联结论。",
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
  const temporal = item.temporal_context;
  const priorIds = Array.isArray(temporal?.prior_observation_ids)
    && temporal.prior_observation_ids.every((id) => typeof id === "string") ? temporal.prior_observation_ids : null;
  const priorLabel = priorIds === null ? "未知（引用信息缺失）" : priorIds.length ? priorIds.join("、") : "无";
  const completeRelations = !!content && priorIds !== null && priorIds.length > 0
    && Array.isArray(temporal?.relations) && temporal.relations.length > 0 && temporal.relations.every((relation) =>
    relation && typeof relation.prior_observation_id === "string" && priorIds.includes(relation.prior_observation_id)
    && ["same_topic", "different_topic", "uncertain"].includes(relation.relation)
    && typeof relation.current_quote === "string" && relation.current_quote.trim().length > 0
    && typeof relation.prior_quote === "string" && relation.prior_quote.trim().length > 0);
  const relations = completeRelations && Array.isArray(temporal?.relations) ? temporal.relations : [];
  const state = temporal?.association_state;
  const states = {skipped: "已跳过", pending: "等待处理", running: "处理中", ready: "处理完成 · 仍为推断", failed: "失败"};
  const stateLabel = state === "ready" && !completeRelations ? "结果不完整 · 未采用"
    : state && Object.prototype.hasOwnProperty.call(states, state) ? states[state] : "状态未知";
  const relationLabels = {same_topic: "可能为同一主题", different_topic: "可能为不同主题", uncertain: "无法确定关系"};
  return <>
    <div className="preview-observation-inference" aria-label="画面观察与推断">
      <small>{content?.summary ? isolated ? "当前画面 AI 观察 · 未核实" : "旧版 AI 整理推断 · 待核实" : "整理状态 · 尚无结论"}</small>
      <p>{content?.summary || (item.state === "model_unavailable" ? "当前画面整理不可用；本机记录仍保留，未生成结论。" : "已保存遮挡后画面，尚未生成整理结论。")}</p>
      {isolated && content && item.current_facts && <small>仅以本帧输入生成，仍可能误读文档；不证明真实操作、远程状态或任务完成。本帧 ID {item.current_facts.observation_id} · 图片依据 {item.current_facts.evidence_id}</small>}
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
          <small>当前观察引文：{relation.current_quote}</small>
          <small>历史观察引文：{relation.prior_quote}</small>
        </div>) : <small>没有可展示的历史关系，不能推断活动变化。</small>}
      </>}
    </div>}
    {!isolated && temporal && <div className="preview-observation-provenance" aria-label="旧版历史上下文">
      <small>旧版历史上下文：{temporal.note || "属于旧版推断，不能作为当前画面独立观察。"}</small>
      <small>旧版引用记录：{priorLabel}。这不是新版独立关联结果。</small>
    </div>}
  </>;
}
