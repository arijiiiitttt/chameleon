import type { PrivacyFinding } from "@chameleon/shared-types";
import { computeRisk, severityFromRisk, type RiskContext } from "@chameleon/privacy-policy";

/**
 * Detector ids encode the source region, e.g. "regex_txt_5_0", "ner_txt_5_1",
 * "dom_email_input". `textRange` offsets are LOCAL to whatever region
 * produced them, so two findings from different regions can have
 * numerically overlapping ranges purely by coincidence - they must never
 * be merged just because the offsets happen to intersect. This extracts
 * the region/element identity a finding's id was scoped to, so merging can
 * be restricted to findings that actually originated from the same region.
 */
function regionKeyOf(finding: PrivacyFinding): string | null {
  const match = finding.id.match(/^(?:regex|ner)_(.+)_\d+$/) ?? finding.id.match(/^dom_(.+)$/);
  return match ? match[1]! : null;
}

/**
 * Two findings are considered the same real-world entity if they share a
 * category, originate from the same region (when that's determinable),
 * and their locations overlap (textRange overlap for text findings, bbox
 * overlap for visual findings).
 */
function sameLocation(a: PrivacyFinding, b: PrivacyFinding): boolean {
  if (a.category !== b.category) return false;

  if (a.textRange && b.textRange) {
    const regionA = regionKeyOf(a);
    const regionB = regionKeyOf(b);
    if (regionA !== null && regionB !== null && regionA !== regionB) return false;
    return !(a.textRange.end <= b.textRange.start || b.textRange.end <= a.textRange.start);
  }
  if (a.bbox && b.bbox) {
    return (
      a.bbox.x < b.bbox.x + b.bbox.width &&
      a.bbox.x + a.bbox.width > b.bbox.x &&
      a.bbox.y < b.bbox.y + b.bbox.height &&
      a.bbox.y + a.bbox.height > b.bbox.y
    );
  }
  return false;
}

export interface ClassifyOptions {
  riskContext?: RiskContext;
}

/**
 * Merges raw findings from independent detectors into a deduplicated set
 * with boosted confidence where multiple detectors agree (spec section 14:
 * "use detector agreement to improve reliability").
 */
export function classifyFindings(
  rawFindings: PrivacyFinding[],
  options: ClassifyOptions = {}
): PrivacyFinding[] {
  const riskContext: RiskContext = options.riskContext ?? { exposure: 1, contextMultiplier: 1 };
  const merged: PrivacyFinding[] = [];

  for (const finding of rawFindings) {
    const existingIdx = merged.findIndex((m) => sameLocation(m, finding));
    if (existingIdx === -1) {
      merged.push({ ...finding, sources: [...finding.sources] });
      continue;
    }

    const existing = merged[existingIdx]!;
    const combinedSources = Array.from(new Set([...existing.sources, ...finding.sources]));
    // Confidence agreement boost: combine using 1 - (1-a)(1-b), capped at 0.995
    const combinedConfidence = Math.min(
      0.995,
      1 - (1 - existing.confidence) * (1 - finding.confidence)
    );

    merged[existingIdx] = {
      ...existing,
      confidence: combinedConfidence,
      sources: combinedSources,
      bbox: existing.bbox ?? finding.bbox,
      textRange: existing.textRange ?? finding.textRange,
    };
  }

  return merged.map((finding) => {
    const risk = computeRisk(finding, riskContext);
    return { ...finding, severity: severityFromRisk(risk) };
  });
}
