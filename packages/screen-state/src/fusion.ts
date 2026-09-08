import type {
  BoundingBox,
  OCRRegion,
  PageMetadata,
  ScreenElement,
  ScreenRelation,
  ScreenState,
  VisualRegion,
  Viewport,
} from "@chameleon/shared-types";

function center(box: BoundingBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function isInside(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x >= b.x &&
    a.y >= b.y &&
    a.x + a.width <= b.x + b.width &&
    a.y + a.height <= b.y + b.height
  );
}

const NEAR_THRESHOLD_PX = 24;

/**
 * Computes coarse spatial relations between elements. This is intentionally
 * simple (O(n^2) over a capped element count) rather than a learned spatial
 * model - see LIMITATIONS.md.
 */
export function computeRelations(elements: ScreenElement[]): ScreenRelation[] {
  const relations: ScreenRelation[] = [];
  const capped = elements.slice(0, 200); // guard against pathological pages

  for (let i = 0; i < capped.length; i++) {
    for (let j = 0; j < capped.length; j++) {
      if (i === j) continue;
      const a = capped[i]!;
      const b = capped[j]!;

      if (isInside(a.bbox, b.bbox) && a.id !== b.id) {
        relations.push({ from: a.id, to: b.id, type: "INSIDE" });
        continue;
      }

      const ca = center(a.bbox);
      const cb = center(b.bbox);
      const dx = cb.x - ca.x;
      const dy = cb.y - ca.y;

      if (Math.abs(dx) < NEAR_THRESHOLD_PX && Math.abs(dy) < NEAR_THRESHOLD_PX) {
        relations.push({ from: a.id, to: b.id, type: "NEAR" });
      } else if (Math.abs(dy) > Math.abs(dx)) {
        relations.push({ from: a.id, to: b.id, type: dy > 0 ? "ABOVE" : "BELOW" });
      } else {
        relations.push({ from: a.id, to: b.id, type: dx > 0 ? "LEFT_OF" : "RIGHT_OF" });
      }
    }
  }

  return relations;
}

export interface FusionInput {
  id: string;
  timestamp: number;
  viewport: Viewport;
  page: PageMetadata;
  elements: ScreenElement[];
  ocrRegions: OCRRegion[];
  visualRegions: VisualRegion[];
}

/**
 * Fuses DOM/ARIA-derived elements with OCR and vision regions into a single
 * ScreenState. Privacy findings are attached later by the privacy pipeline -
 * fusion itself never inspects content for sensitivity.
 */
export function fuseScreenState(input: FusionInput): ScreenState {
  const relations = computeRelations(input.elements);

  const elementConfidences = input.elements.map((e) => e.confidence);
  const overallConfidence =
    elementConfidences.length === 0
      ? 0.5
      : elementConfidences.reduce((a, b) => a + b, 0) / elementConfidences.length;

  return {
    id: input.id,
    timestamp: input.timestamp,
    viewport: input.viewport,
    page: input.page,
    elements: input.elements,
    visualRegions: input.visualRegions,
    ocrRegions: input.ocrRegions,
    relations,
    privacyFindings: [],
    confidence: overallConfidence,
  };
}
