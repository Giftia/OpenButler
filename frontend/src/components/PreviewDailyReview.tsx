import {useEffect, useRef, useState} from "react";
import {generateDailyReview, type DailyReview} from "../lib/api";

export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function zonedTime(value: string | null, timezone: string) {
  if (!value) return "尚无记录";
  try { return new Date(value).toLocaleString("zh-CN", {timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"}); }
  catch { return "时间不可用"; }
}

function Evidence({item, timezone}: {item: DailyReview["conclusions"][number]["evidence_refs"][number]; timezone: string}) {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);

  async function toggle() {
    if (open) { revision.current++; setOpen(false); setBusy(false); setImage(null); return; }
    const current = ++revision.current;
    setOpen(true); setImage(null); setBusy(true); setMessage("正在读取遮挡后依据…");
    try {
      const result = await window.openbutlerDesktop?.getMaskedEvidence?.(item.evidence_id);
      if (current !== revision.current) return;
      if (result?.ok && result.dataUrl.startsWith("data:image/png;base64,")) {
        setImage(result.dataUrl); setMessage("");
      } else setMessage("依据已过期、被删除或暂不可用。请重新生成回看。");
    } catch {
      if (current === revision.current) setMessage("依据暂时无法读取，请重试；这不代表依据仍可用。");
    } finally { if (current === revision.current) setBusy(false); }
  }

  return <div className="daily-review-evidence">
    <button className="secondary" aria-expanded={open} onClick={() => void toggle()}>
      {open ? "收起依据" : "查看依据"} · {zonedTime(item.captured_at, timezone)}
    </button>
    {open && <div aria-busy={busy}>
      {message && <p role="status">{message}</p>}
      {image && <img className="preview-evidence-image" src={image} alt="这项回看结论对应的本机遮挡后依据" />}
      <small>记录 {item.observation_id} · 仅显示遮挡后图片</small>
    </div>}
  </div>;
}

export function PreviewDailyReview({recordRevision, authorized}: {recordRevision: string; authorized: boolean}) {
  const [day, setDay] = useState(localDay);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [result, setResult] = useState<DailyReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const revision = useRef(0);
  const mounted = useRef(true);
  const active = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => {
    revision.current++;
    setResult(null); setBusy(false); active.current = false;
    setMessage("");
  }, [recordRevision, authorized]);

  function invalidate() {
    revision.current++; active.current = false;
    setResult(null); setBusy(false); setMessage("范围已更改，请手动生成新的回看。");
  }

  async function generate() {
    if (active.current || !authorized) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { setMessage("请选择有效日期。"); return; }
    try { new Intl.DateTimeFormat("zh-CN", {timeZone: timezone}).format(); }
    catch { setMessage("请输入有效的 IANA 时区，例如 Asia/Shanghai。"); return; }
    const current = ++revision.current;
    active.current = true; setBusy(true); setResult(null); setMessage("");
    try {
      const next = await generateDailyReview(day, timezone);
      if (!mounted.current || current !== revision.current) return;
      setResult(next);
      if (next.status === "unavailable") setMessage("回看暂未生成。请检查模型、录制授权和依据是否仍有效，再手动重试。");
    } catch {
      if (mounted.current && current === revision.current) setMessage("回看请求未完成，请检查日期、时区、模型和本机服务后重试。没有生成结论。");
    } finally {
      if (mounted.current && current === revision.current) { active.current = false; setBusy(false); }
    }
  }

  const counts = result?.counts;
  return <section className="today-panel preview-daily-review" aria-labelledby="daily-review-title">
    <div className="section-title"><div><p className="eyebrow">今日回看</p><h2 id="daily-review-title">把多条记录串起来</h2></div><span className="privacy-chip">手动生成 · 每项附依据</span></div>
    <p>只汇总所选日期内已有且依据可用的本机记录。没有记录的时段仍是未知，不能视为没有活动。</p>
    <div className="daily-review-scope">
      <label>日期<input type="date" value={day} onChange={(event) => { setDay(event.target.value); invalidate(); }} /></label>
      <label>时区<input value={timezone} onChange={(event) => { setTimezone(event.target.value); invalidate(); }} placeholder="Asia/Shanghai" spellCheck={false} /></label>
      <button className="primary" disabled={busy || !authorized} onClick={() => void generate()}>{busy ? "正在生成回看…" : result ? "重新生成回看" : "生成这一天的回看"}</button>
    </div>
    <small>点击后才调用已验证的文字模型；仅使用已有记录摘要，遵守当前模型接收方与隐私授权。不会开始录制。</small>
    {!authorized && <p className="policy-note">录制授权尚未建立或已撤销。重新授权后才能处理这些记录；不会自动恢复录制。</p>}
    {message && <p className="policy-note" role="status">{message}</p>}
    {result && counts && <div className="daily-review-result" aria-busy={busy}>
      <div className="daily-review-counts" aria-label="所选日期记录状态">
        <span>全部 {counts.total}</span><span>已整理 {counts.ready}</span><span>待整理 {counts.pending}</span><span>失败 {counts.failed}</span><span>本次纳入 {counts.included}</span>
      </div>
      <p>观察点范围：{zonedTime(result.coverage.observed_start, result.timezone)}{result.coverage.observed_end ? ` 至 ${zonedTime(result.coverage.observed_end, result.timezone)}` : ""}（{result.timezone}）。范围不等于连续覆盖。</p>
      <p className="policy-note">{result.boundary}</p>
      {(counts.expired_evidence > 0 || counts.missing_evidence > 0 || counts.invalid_records > 0) && <p role="status">未采用：{counts.expired_evidence} 条依据过期，{counts.missing_evidence} 条依据缺失，{counts.invalid_records} 条记录无效。</p>}
      {(result.truncated || counts.omitted > 0) && <p role="status">本次输入受数量或长度限制，有 {counts.omitted} 条合格记录未纳入。这不是完整的全天总结。</p>}
      {result.status === "empty" && <p>这一天尚无可用于回看的记录，没有调用模型。</p>}
      {result.status === "unavailable" && <small>状态：{result.reason || "review_unavailable"}。记录计数保留，未生成结论。</small>}
      {result.status === "ready" && <ol className="daily-review-conclusions">{result.conclusions.map((conclusion, index) => <li key={`${result.generated_at}-${index}`}>
        <p>{conclusion.text}</p>
        <div className="daily-review-evidence-list">{conclusion.evidence_refs.map((item) => <Evidence key={item.observation_id} item={item} timezone={result.timezone} />)}</div>
      </li>)}</ol>}
      {result.coverage.gap_count > 0 && <details className="daily-review-gaps"><summary>{result.coverage.gap_count} 段观察空缺（至少 {Math.round(result.coverage.gap_threshold_seconds / 60)} 分钟）</summary>
        <p>以下时段缺少观察点，不能推断是否有活动。</p>
        <ul>{result.coverage.gaps.map((gap) => <li key={`${gap.start}-${gap.end}`}>{zonedTime(gap.start, result.timezone)} 至 {zonedTime(gap.end, result.timezone)}</li>)}</ul>
        {result.coverage.gaps_truncated && <small>这里只列出部分空缺时段。</small>}
      </details>}
    </div>}
  </section>;
}
