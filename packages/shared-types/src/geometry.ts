/**
 * Geometry primitives shared by DOM extraction, OCR, vision, and redaction.
 * Kept dependency-free so they can be used in both extension and server code.
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

/** Intersection-over-Union between two bounding boxes. Used by redaction metrics. */
export function iou(a: BoundingBox, b: BoundingBox): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const interX1 = Math.max(a.x, b.x);
  const interY1 = Math.max(a.y, b.y);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interWidth = Math.max(0, interX2 - interX1);
  const interHeight = Math.max(0, interY2 - interY1);
  const interArea = interWidth * interHeight;

  const unionArea = a.width * a.height + b.width * b.height - interArea;
  if (unionArea <= 0) return 0;
  return interArea / unionArea;
}
