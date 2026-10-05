import {Fragment, type ReactNode} from "react";
import type {CaptureCoverageEvent, ContextObservation} from "../lib/api";

type Entry = {type: "observation"; item: ContextObservation; order: number} |
  {type: "coverage"; item: CaptureCoverageEvent; order: number};

function timestamp(value?: string | null): number | null {
  if (!value) return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function time(value?: string | null): string {
  const result = timestamp(value);
  return result === null ? "时间未知" : new Date(result).toLocaleString("zh-CN", {hour12: false});
}

function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1 && milliseconds > 0) return "不足 1 秒";
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
  return parts.map((value, i) => value ? `${value} ${["小时", "分钟", "秒"][i]}` : "").filter(Boolean).join(" ") || "0 秒";
}

function compareEntries(a: Entry, b: Entry): number {
  const aTime = timestamp(a.type === "coverage" ? a.item.occurred_at : a.item.captured_at);
  const bTime = timestamp(b.type === "coverage" ? b.item.occurred_at : b.item.captured_at);
  if (aTime !== bTime) return (bTime ?? -Infinity) - (aTime ?? -Infinity);
  // API event order is durable. Equal display timestamps must not reorder it.
  if (a.type !== b.type) return a.type === "coverage" ? -1 : 1;
  return a.order - b.order;
}

export function captureFeedEntries(observations: ContextObservation[], coverageEvents: CaptureCoverageEvent[]): Entry[] {
  return [
    ...observations.map((item, order): Entry => ({type: "observation", item, order})),
    ...coverageEvents.map((item, order): Entry => ({type: "coverage", item, order})),
  ].sort(compareEntries);
}

function title(event: CaptureCoverageEvent): string {
  switch (event.kind) {
    case "started": return timestamp(event.first_sample_at) === null ? "已启动 · 等待首次采样" : "已启动采样";
    case "paused": return "采集已暂停";
    case "revoked": return "录制授权已撤销";
    case "reconfigured": return "采集范围已更改";
    case "stopped": return "采集已停止";
    case "process_restarted": return "进程重启 · 停机起点未知";
    default: return "采集边界记录";
  }
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "user_paused": return "手动暂停";
    case "session_expired": return "授权时限已到";
    case "source_unavailable": return "采集来源不可用";
    case "capture_error": return "采集失败";
    case "configuration_changed": return "配置已更改";
    case "shutdown": return "进程停止";
    default: return "";
  }
}

function isOpenGap(event: CaptureCoverageEvent): boolean {
  return event.kind !== "started" && !event.gap_end_known && !event.gap_end_at;
}

export function CaptureCoverageRow({event}: {event: CaptureCoverageEvent}) {
  const start = timestamp(event.gap_started_at);
  const end = timestamp(event.gap_end_at);
  const knownStart = event.gap_start_known && start !== null && event.kind !== "process_restarted";
  const knownEnd = event.gap_end_known && end !== null && (start === null || end >= start);
  const unknownEnd = isOpenGap(event) ? "尚无后续接受采样" : "后续采样时间未知";
  const reason = reasonLabel(event.reason);
  return <article className="preview-observation-row preview-coverage-row" data-coverage-kind={event.kind} aria-label="采集覆盖边界">
    <div className="preview-coverage-time"><small>{event.kind === "process_restarted" ? "重启发现时间" : "边界记录时间"}</small><time dateTime={timestamp(event.occurred_at) === null ? undefined : event.occurred_at}>{time(event.occurred_at)}</time></div>
    <div className="preview-observation-body">
      <div className="moment-title-row"><strong>{title(event)}</strong><span className="moment-state">覆盖边界 · 非观察记录</span></div>
      <small>{event.source_kind === "public_window" ? "专用公开窗口" : event.source_kind === "full_screen" ? "已授权屏幕" : "采集来源未知"}{reason ? ` · ${reason}` : ""}</small>
      {event.kind === "started" ? <p>{timestamp(event.first_sample_at) === null
        ? "启动只代表尝试采样；尚无首次接受采样，不能据此结束此前空缺。"
        : `首次接受采样：${time(event.first_sample_at)}。只确认该离散采样点，不代表连续覆盖。`}</p> : <>
        {knownStart ? <p>采样空缺：{time(event.gap_started_at)} → {knownEnd ? time(event.gap_end_at) : unknownEnd}{knownEnd ? ` · ${duration(end! - start!)}` : ""}</p>
          : <p>实际停止时间未知，不能计算停机时长。{event.kind === "process_restarted" ? "重启发现时间不代表实际停机时间。" : "缺少可确认的空缺起点。"}</p>}
        {!knownStart && <small>{timestamp(event.last_sample_at) !== null ? `最后已接受采样：${time(event.last_sample_at)}。` : "此前最后采样时间未知。"}{knownEnd ? `后续接受采样：${time(event.gap_end_at)}。` : `${unknownEnd}。`}</small>}
        {knownEnd && <small>空缺结束仅表示接受了新的采样，采样之间的活动仍未知。</small>}
        {isOpenGap(event) && <small>空缺仍未关闭；启动尝试不会补回遗漏的活动。</small>}
      </>}
    </div>
  </article>;
}

export function CaptureObservationFeed({observations, coverageEvents = [], renderObservation, limit}: {
  observations: ContextObservation[];
  coverageEvents?: CaptureCoverageEvent[];
  renderObservation: (item: ContextObservation) => ReactNode;
  limit?: number;
}) {
  const allEntries = captureFeedEntries(observations, coverageEvents);
  const entries = limit ? allEntries.slice(0, limit) : allEntries;
  // Keep the latest unclosed gap visible even after many failed start attempts.
  const latestOpenEvent = coverageEvents.find(isOpenGap);
  const openGap = allEntries.find((entry) => entry.type === "coverage" && entry.item === latestOpenEvent);
  if (openGap && !entries.includes(openGap)) entries.push(openGap);
  return <div className="preview-capture-feed">
    <p className="policy-note">记录是离散采样，不是连续录屏。采样之间与未采集时段的活动未知；边界事件不是截图记录。</p>
    <small className="preview-coverage-legacy">旧版记录可能缺少启动、暂停或停机边界；没有边界记录不代表持续采集。</small>
    {entries.length ? <div className="life-timeline event-feed">{entries.map((entry) => <Fragment key={`${entry.type}:${entry.item.id}`}>
      {entry.type === "coverage" ? <CaptureCoverageRow event={entry.item} /> : renderObservation(entry.item)}
    </Fragment>)}</div> : <div className="friendly-empty"><strong>还没有本机记录或采集边界</strong><span>完成隐私预览并启动后，接受的采样与采集边界会分别显示。</span></div>}
    {!!entries.length && !observations.length && <small>还没有已保存的观察记录；上述边界不代表已成功保存截图。</small>}
  </div>;
}
