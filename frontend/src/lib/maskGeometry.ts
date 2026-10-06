/** Coordinates are pixels in the already-masked PNG, never CSS or desktop pixels. */
export type MaskRect = {x: number; y: number; width: number; height: number};
export type ImageBounds = {width: number; height: number};
export type ImagePoint = {x: number; y: number};
export type ResizeCorner = "nw" | "ne" | "sw" | "se";
export type RenderedImageRect = {left: number; top: number; width: number; height: number};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.round(value) : fallback;

export function validImageBounds(bounds: ImageBounds): boolean {
  return Number.isSafeInteger(bounds.width) && bounds.width > 0
    && Number.isSafeInteger(bounds.height) && bounds.height > 0;
}

export function clampMask(rect: MaskRect, bounds?: ImageBounds | null): MaskRect {
  const width = bounds && validImageBounds(bounds) ? bounds.width : Number.MAX_SAFE_INTEGER;
  const height = bounds && validImageBounds(bounds) ? bounds.height : Number.MAX_SAFE_INTEGER;
  const x = clamp(integer(rect.x, 0), 0, width - 1);
  const y = clamp(integer(rect.y, 0), 0, height - 1);
  return {
    x, y,
    width: clamp(integer(rect.width, 1), 1, width - x),
    height: clamp(integer(rect.height, 1), 1, height - y),
  };
}

export function sameMask(a: MaskRect, b: MaskRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function pointInImage(client: ImagePoint, rendered: RenderedImageRect, bounds: ImageBounds): ImagePoint | null {
  if (!validImageBounds(bounds) || ![client.x, client.y, rendered.left, rendered.top, rendered.width, rendered.height].every(Number.isFinite)
      || rendered.width <= 0 || rendered.height <= 0) return null;
  return {
    x: clamp((client.x - rendered.left) * bounds.width / rendered.width, 0, bounds.width),
    y: clamp((client.y - rendered.top) * bounds.height / rendered.height, 0, bounds.height),
  };
}

/** Round outwards so a drag does not leave a fractional edge uncovered. */
export function maskFromPoints(start: ImagePoint, end: ImagePoint, bounds: ImageBounds): MaskRect {
  const x = Math.floor(clamp(Math.min(start.x, end.x), 0, bounds.width));
  const y = Math.floor(clamp(Math.min(start.y, end.y), 0, bounds.height));
  const right = Math.ceil(clamp(Math.max(start.x, end.x), 0, bounds.width));
  const bottom = Math.ceil(clamp(Math.max(start.y, end.y), 0, bounds.height));
  return clampMask({x, y, width: right - x, height: bottom - y}, bounds);
}

export function resizeMask(rect: MaskRect, corner: ResizeCorner, delta: ImagePoint, bounds: ImageBounds): MaskRect {
  const west = corner.includes("w");
  const north = corner.includes("n");
  const fixed = {x: west ? rect.x + rect.width : rect.x, y: north ? rect.y + rect.height : rect.y};
  const moved = {x: (west ? rect.x : rect.x + rect.width) + delta.x, y: (north ? rect.y : rect.y + rect.height) + delta.y};
  return maskFromPoints(fixed, moved, bounds);
}

export function moveMask(rect: MaskRect, delta: ImagePoint, bounds: ImageBounds): MaskRect {
  const normalized = clampMask(rect, bounds);
  return {...normalized,
    x: clamp(integer(normalized.x + delta.x, normalized.x), 0, bounds.width - normalized.width),
    y: clamp(integer(normalized.y + delta.y, normalized.y), 0, bounds.height - normalized.height),
  };
}
