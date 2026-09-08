import type { BoundingBox, OCRRegion } from "@chameleon/shared-types";

export interface DomTextNodeInput {
  id: string;
  text: string;
  bbox: BoundingBox;
}

/**
 * Wraps DOM-extracted text nodes in the same `OCRRegion` shape the privacy
 * detectors already consume, so regex/NER detectors can run uniformly over
 * "visually rendered text" regardless of whether it came from the DOM
 * (fast, accurate, always available) or from real image OCR (slow, only
 * needed for canvas/image content). Confidence is 1.0 because the text is
 * read directly from the DOM, not visually inferred.
 */
export function domTextNodesToRegions(nodes: DomTextNodeInput[]): OCRRegion[] {
  return nodes.map((n) => ({
    id: n.id,
    text: n.text,
    bbox: n.bbox,
    confidence: 1.0,
  }));
}
