import type { DetectionSource, PrivacyFinding, TextRange } from "@chameleon/shared-types";

/**
 * HONESTY NOTE (spec section 83 - "do not fake local inference"):
 * This is a heuristic, label-anchored detector, NOT a trained named-entity
 * recognition model. It looks for capitalised "First Last" style tokens
 * immediately following a field label such as "Operator:", "Name:", or
 * "Attn:". It intentionally reports lower confidence than the DOM and
 * regex detectors to reflect this. A real transformer-based NER model can
 * be dropped in behind the same `NerDetector` interface below without
 * changing any downstream code.
 */

export interface NerDetectorInput {
  regionId: string;
  text: string;
  source: DetectionSource;
}

export interface NerDetector {
  detect(inputs: NerDetectorInput[]): PrivacyFinding[];
}

const LABEL_ANCHORED_NAME = /\b(?:Operator|Name|Attn|Contact|Employee|Customer)\s*:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g;

// Fallback: any two-or-three consecutive capitalised words not at sentence start punctuation.
const BARE_PROPER_NAME = /\b([A-Z][a-z]{1,20}\s+[A-Z][a-z]{1,20})\b/g;

export class HeuristicNerDetector implements NerDetector {
  detect(inputs: NerDetectorInput[]): PrivacyFinding[] {
    const findings: PrivacyFinding[] = [];
    let counter = 0;

    for (const input of inputs) {
      LABEL_ANCHORED_NAME.lastIndex = 0;
      let match: RegExpExecArray | null;
      const labelledSpans: TextRange[] = [];

      while ((match = LABEL_ANCHORED_NAME.exec(input.text)) !== null) {
        const nameStart = match.index + match[0].indexOf(match[1]!);
        const range: TextRange = { start: nameStart, end: nameStart + match[1]!.length };
        labelledSpans.push(range);
        findings.push({
          id: `ner_${input.regionId}_${counter++}`,
          category: "PERSON",
          textRange: range,
          confidence: 0.88,
          severity: "MEDIUM",
          sources: [input.source, "NER"],
        });
      }

      // lower-confidence bare heuristic, skipped where a labelled match already covers the span
      BARE_PROPER_NAME.lastIndex = 0;
      while ((match = BARE_PROPER_NAME.exec(input.text)) !== null) {
        const range: TextRange = { start: match.index, end: match.index + match[0].length };
        const overlaps = labelledSpans.some((s) => range.start >= s.start && range.end <= s.end + 20);
        if (overlaps) continue;
        findings.push({
          id: `ner_${input.regionId}_${counter++}`,
          category: "PERSON",
          textRange: range,
          confidence: 0.55,
          severity: "LOW",
          sources: [input.source, "NER"],
        });
      }
    }

    return findings;
  }
}
