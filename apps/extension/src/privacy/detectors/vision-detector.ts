import type { PrivacyFinding, SensitivityType, VisualRegion } from "@chameleon/shared-types";

/**
 * Maps a vision model's `VisualRegionKind` to the privacy taxonomy's
 * `SensitivityType`. `document`/`table` map to DOCUMENT (structured/
 * scanned content warrants the same caution either way); `image` (a
 * classified "photo"-like region with no detected face) maps to the
 * generic OTHER category since it may still contain identifiable
 * content a face detector alone would miss. Kinds with no privacy
 * implication - `chart`, `code`, `button-like`, `input-like` - are
 * intentionally NOT mapped and produce no finding, since flagging every
 * visual region as sensitive would make the FACE/DOCUMENT categories
 * meaningless noise.
 */
const KIND_TO_CATEGORY: Partial<Record<VisualRegion["kind"], SensitivityType>> = {
  face: "FACE",
  person: "FACE",
  document: "DOCUMENT",
  table: "DOCUMENT",
  image: "OTHER",
  "sensitive-visual-region": "OTHER",
};

/**
 * Detects sensitivity from local vision model output (spec: FACE category,
 * visual document detection). Runs alongside the DOM/regex/NER detectors
 * and feeds the same `classifyFindings` merge/confidence-boost step -
 * `backendUsed: "unavailable"` (no real model loaded) naturally yields an
 * empty `VisualRegion[]`, so this detector produces zero findings rather
 * than a fabricated one, matching the vision model's own fail-closed
 * contract.
 */
export function detectVisionSensitivity(regions: VisualRegion[]): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];

  for (const region of regions) {
    const category = KIND_TO_CATEGORY[region.kind];
    if (!category) continue;
    // A region whose own backend is "unavailable" carries no real signal
    // (should never happen in practice since FallbackVisionModel returns
    // zero regions, but this keeps the detector safe if a future model
    // implementation returns partial/degraded regions instead).
    if (region.backend === "unavailable") continue;

    findings.push({
      id: `vision_${region.id}`,
      category,
      bbox: region.bbox,
      confidence: region.confidence,
      severity: "MEDIUM", // finalized later by the risk engine
      sources: ["VISION"],
    });
  }

  return findings;
}
