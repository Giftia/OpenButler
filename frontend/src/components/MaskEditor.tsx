import {useEffect, useId, useRef, useState} from "react";
import type {KeyboardEvent, PointerEvent} from "react";
import {clampMask, maskFromPoints, moveMask, pointInImage, resizeMask} from "../lib/maskGeometry";
import type {ImageBounds, ImagePoint, MaskRect, ResizeCorner} from "../lib/maskGeometry";

export type MaskedEditingCanvas = {
  url: string;
  maskedRegions: number;
  bounds: ImageBounds | null;
  fresh: boolean;
};

type Gesture = {pointerId: number; start: ImagePoint; original: MaskRect[]; index: number; corner?: ResizeCorner};
const corners: ResizeCorner[] = ["nw", "ne", "sw", "se"];
const cornerLabels = {nw: "左上角", ne: "右上角", sw: "左下角", se: "右下角"};
const fieldLabels = {x: "左侧 X", y: "顶部 Y", width: "宽度", height: "高度"};

export function MaskEditor({masks, canvas, disabled, editing, onChange, onEditStart, onEditingChange, onImageLoad, onImageError}: {
  masks: MaskRect[];
  canvas: MaskedEditingCanvas | null;
  disabled: boolean;
  editing: boolean;
  onChange: (masks: MaskRect[]) => void;
  onEditStart: () => void;
  onEditingChange: (editing: boolean) => void;
  onImageLoad: (bounds: ImageBounds) => void;
  onImageError: () => void;
}) {
  const instructionsId = useId();
  const imageRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<MaskRect[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState(true);
  const bounds = canvas?.bounds ?? null;
  const shownMasks = draft ?? masks;

  function endGesture() {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDraft(null);
    if (gesture && surfaceRef.current?.hasPointerCapture(gesture.pointerId)) surfaceRef.current.releasePointerCapture(gesture.pointerId);
    onEditingChange(false);
  }

  useEffect(() => {
    if (disabled && gestureRef.current) endGesture();
  }, [disabled]);

  function point(event: PointerEvent): ImagePoint | null {
    if (!bounds || !imageRef.current) return null;
    return pointInImage({x: event.clientX, y: event.clientY}, imageRef.current.getBoundingClientRect(), bounds);
  }

  function startGesture(event: PointerEvent, index?: number, corner?: ResizeCorner) {
    if (disabled || editing || gestureRef.current || event.button !== 0 || !event.isPrimary || !bounds) return;
    const start = point(event);
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const original = masks.map((mask) => ({...mask}));
    const nextIndex = index ?? original.length;
    gestureRef.current = {pointerId: event.pointerId, start, original, index: nextIndex, corner};
    surfaceRef.current?.focus({preventScroll: true});
    surfaceRef.current?.setPointerCapture(event.pointerId);
    setSelected(nextIndex);
    setDraft(index === undefined ? [...original, maskFromPoints(start, start, bounds)] : original);
    onEditStart();
    onEditingChange(true);
  }

  function nextDraft(event: PointerEvent): MaskRect[] | null {
    const gesture = gestureRef.current;
    const current = point(event);
    if (!gesture || event.pointerId !== gesture.pointerId || !bounds || !current) return null;
    const rect = gesture.corner
      ? resizeMask(gesture.original[gesture.index], gesture.corner, {x: current.x - gesture.start.x, y: current.y - gesture.start.y}, bounds)
      : maskFromPoints(gesture.start, current, bounds);
    const next = [...gesture.original];
    next[gesture.index] = rect;
    return next;
  }

  function finishGesture(event: PointerEvent) {
    const next = nextDraft(event);
    if (!next) return;
    if (!disabled) onChange(next);
    endGesture();
    setDrawMode(false);
  }

  function remove(index: number) {
    if (disabled || editing) return;
    onChange(masks.filter((_, itemIndex) => itemIndex !== index));
    setSelected(null);
  }

  function adjustWithKeyboard(event: KeyboardEvent, index: number) {
    if (disabled || editing) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(index);
      return;
    }
    if (!bounds || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const delta = {x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0};
    onChange(masks.map((mask, itemIndex) => itemIndex === index ? moveMask(mask, delta, bounds) : mask));
  }

  return <section className="preview-mask-editor" aria-label="遮挡区域编辑器" aria-describedby={instructionsId}>
    <div className="preview-mask-heading"><strong>遮挡区域</strong><button type="button" className="secondary" disabled={disabled || editing}
      onClick={() => { setSelected(masks.length); onChange([...masks, clampMask({x: 0, y: 0, width: 100, height: 100}, bounds)]); }}>添加区域</button></div>
    <p id={instructionsId} className="policy-note">先检查隐私预览，再在已遮挡画面上拖动绘制。选择区域后拖动四角调整，也可用下方数值输入。坐标按预览原图像素计算。</p>
    {canvas ? <div className={`masked-preview preview-mask-canvas${canvas.fresh ? "" : " is-stale"}`}>
      <div className="preview-mask-canvas-status" role="status">
        {canvas.fresh ? "已遮挡的隐私预览" : "旧的已遮挡画面 · 仅供编辑，不能用于录制确认"}
      </div>
      <div className="preview-mask-tools" aria-label="编辑工具">
        <button type="button" className="secondary" aria-pressed={drawMode} disabled={disabled || editing || !bounds} onClick={() => setDrawMode(true)}>绘制区域</button>
        <button type="button" className="secondary" aria-pressed={!drawMode} disabled={disabled || editing || !bounds} onClick={() => setDrawMode(false)}>选择 / 调整</button>
        <span>{bounds ? `${bounds.width} × ${bounds.height} 像素` : "正在加载已遮挡图片…"}</span>
      </div>
      <div ref={surfaceRef} tabIndex={-1} role="group" aria-label="在已遮挡图像上编辑区域；按 Escape 取消拖动" className={`preview-mask-surface${drawMode ? " is-drawing" : ""}${disabled ? " is-disabled" : ""}`}
        onPointerDown={(event) => { if (drawMode) startGesture(event); }}
        onPointerMove={(event) => { const next = nextDraft(event); if (next) setDraft(next); }}
        onPointerUp={finishGesture}
        onPointerCancel={(event) => { if (gestureRef.current?.pointerId === event.pointerId) endGesture(); }}
        onLostPointerCapture={(event) => { if (gestureRef.current?.pointerId === event.pointerId) endGesture(); }}
        onKeyDown={(event) => { if (event.key === "Escape" && gestureRef.current) { event.preventDefault(); endGesture(); } }}>
        <img ref={imageRef} src={canvas.url} alt={canvas.fresh ? "本机识别并遮挡后的隐私预览" : "旧的已遮挡编辑画面，不能用于录制确认"} draggable={false}
          onLoad={(event) => onImageLoad({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})} onError={onImageError} />
        {bounds && shownMasks.map((mask, index) => <div key={index} className={`preview-mask-region${selected === index ? " is-selected" : ""}`}
          style={{left: `${mask.x / bounds.width * 100}%`, top: `${mask.y / bounds.height * 100}%`, width: `${mask.width / bounds.width * 100}%`, height: `${mask.height / bounds.height * 100}%`}}>
          <button type="button" className="preview-mask-select" disabled={disabled || editing}
            aria-label={`选择遮挡区域 ${index + 1}，可用方向键移动或 Delete 删除，也可在下方输入数值`} aria-pressed={selected === index}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => { setSelected(index); setDrawMode(false); }}
            onFocus={() => setSelected(index)} onKeyDown={(event) => adjustWithKeyboard(event, index)} />
          <span className="preview-mask-number" aria-hidden="true">{index + 1}</span>
          {selected === index && corners.map((corner) => <button key={corner} type="button"
            className={`preview-mask-handle at-${corner}`} disabled={disabled || editing} tabIndex={-1}
            aria-label={`拖动区域 ${index + 1} 的${cornerLabels[corner]}调整大小；键盘请使用下方宽高输入`}
            onPointerDown={(event) => startGesture(event, index, corner)} />)}
        </div>)}
      </div>
      <small>上次预览已遮挡 {canvas.maskedRegions} 处。删除或缩小区域不会恢复旧图内容；重新预览后才能检查新范围。</small>
      {!canvas.fresh && <p className="policy-note">设置已改变。请重新点击“检查隐私预览”，再勾选确认。</p>}
    </div> : <p className="preview-mask-empty">尚无已遮挡预览。可先填写区域坐标，或检查预览后开始绘制。</p>}
    <div className="preview-mask-numeric" aria-label="按原图像素编辑遮挡区域">
      {!masks.length && <p className="policy-note">尚未添加手动遮挡区域，本机自动遮挡仍会执行。</p>}
      {masks.map((mask, index) => <fieldset className="preview-mask-fields" key={index} disabled={disabled || editing}>
        <legend>区域 {index + 1}</legend>
        <div className="preview-mask-row">
          {(["x", "y", "width", "height"] as const).map((field) => <label key={field}><span>{fieldLabels[field]}</span>
            <input type="number" inputMode="numeric" step={1} min={field === "width" || field === "height" ? 1 : 0}
              max={bounds ? field === "x" ? bounds.width - 1 : field === "y" ? bounds.height - 1 : field === "width" ? bounds.width - mask.x : bounds.height - mask.y : undefined}
              aria-label={`遮挡区域 ${index + 1} ${fieldLabels[field]}（像素）`} value={mask[field]}
              onChange={(event) => { setSelected(index); onChange(masks.map((item, itemIndex) => itemIndex === index ? clampMask({...item, [field]: Number(event.target.value)}, bounds) : item)); }} />
          </label>)}
          <button type="button" className="ghost" aria-label={`删除遮挡区域 ${index + 1}`} onClick={() => remove(index)}>删除</button>
        </div>
      </fieldset>)}
    </div>
  </section>;
}
