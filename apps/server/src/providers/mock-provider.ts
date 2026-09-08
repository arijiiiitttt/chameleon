import type { SanitizedRequestValidated } from "../shared/protocol.js";
import type { ActionPlan } from "../shared/action-dsl.js";
import type { ReasoningProvider } from "./types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "please",
  "find", "then", "this", "that", "is", "are",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  );
}

function overlapScore(intentWords: Set<string>, labelWords: Set<string>): number {
  let hits = 0;
  for (const w of labelWords) if (intentWords.has(w)) hits += 1;
  return labelWords.size === 0 ? 0 : hits / labelWords.size;
}

let actionCounter = 0;
function nextActionId(): string {
  actionCounter += 1;
  return `a-${String(actionCounter).padStart(3, "0")}`;
}

/**
 * A deterministic, rule-based planner used for offline development and the
 * SIH demo (no external AI API required). It scores every interactive
 * element's label against the user's intent by word overlap and proposes
 * a CLICK on the best match above a threshold - this is domain-independent
 * word-overlap matching, NOT a hardcoded "if satellite-page then click
 * acknowledge_42" rule (see docs/LIMITATIONS.md for why this matters and
 * where it would need to be replaced by a real VLM/LLM for arbitrary
 * pages). If the intent mentions scrolling and nothing scores well enough,
 * it proposes a SCROLL instead.
 *
 * Vision-informed decisions (spec: the vision layer should inform
 * DECISIONS, not just redaction - see docs/LIMITATIONS.md's "vision now
 * informs decisions" entry): `context.screen.elements` may contain
 * `role: "region"` pseudo-elements produced by the client's real vision
 * models (scene classifier / face detector), labeled only with their kind
 * ("Document region", "Data table region", "Chart region" - never pixel
 * content or OCR'd text). If no interactive element scores well enough
 * AND the intent's words suggest interest in exactly that kind of visual
 * content (e.g. "read the document", "check the table"), this proposes an
 * EXTRACT on that region instead of giving up with DONE - a genuinely
 * different decision than this planner could make before the vision
 * signal existed, not a relabeled existing branch.
 */
export class MockReasoningProvider implements ReasoningProvider {
  async generatePlan(context: SanitizedRequestValidated): Promise<ActionPlan> {
    const intentWords = words(context.userIntent);

    let best: { id: string; label: string; score: number } | null = null;
    for (const el of context.screen.elements) {
      if (!el.interactive) continue;
      const score = overlapScore(intentWords, words(el.label));
      if (score > 0 && (!best || score > best.score)) {
        best = { id: el.id, label: el.label, score };
      }
    }

    if (best && best.score >= 0.5) {
      return {
        requestId: context.requestId,
        actions: [
          {
            actionId: nextActionId(),
            type: "CLICK",
            targetId: best.id,
            confidence: Math.min(0.99, 0.7 + best.score * 0.3),
            reason: `Matched intent keywords to interactive element "${best.label}" (overlap ${best.score.toFixed(2)}).`,
          },
        ],
        rationale: `Selected "${best.label}" as the best word-overlap match for the stated intent.`,
        confidence: Math.min(0.99, 0.7 + best.score * 0.3),
      };
    }

    // No confident CLICK target - check whether the client's local vision
    // models flagged a document/table/chart region that matches the
    // intent's own words (same word-overlap scoring as above, applied to
    // the region's non-interactive label instead of a clickable one).
    let bestRegion: { id: string; label: string; score: number } | null = null;
    for (const el of context.screen.elements) {
      if (el.interactive || el.role !== "region") continue;
      const score = overlapScore(intentWords, words(el.label));
      if (score > 0 && (!bestRegion || score > bestRegion.score)) {
        bestRegion = { id: el.id, label: el.label, score };
      }
    }
    if (bestRegion && bestRegion.score >= 0.3) {
      return {
        requestId: context.requestId,
        actions: [
          {
            actionId: nextActionId(),
            type: "EXTRACT",
            targetId: bestRegion.id,
            confidence: Math.min(0.9, 0.6 + bestRegion.score * 0.3),
            reason: `Local vision model flagged a "${bestRegion.label}" matching the intent (overlap ${bestRegion.score.toFixed(2)}); extracting it since no interactive element matched.`,
          },
        ],
        rationale: `No clickable element matched the intent, but the client's on-device vision model detected a "${bestRegion.label}" relevant to it - extracting that instead of giving up.`,
        confidence: Math.min(0.9, 0.6 + bestRegion.score * 0.3),
      };
    }

    if (intentWords.has("scroll") || intentWords.has("down") || intentWords.has("up")) {
      return {
        requestId: context.requestId,
        actions: [
          {
            actionId: nextActionId(),
            type: "SCROLL",
            direction: intentWords.has("up") ? "UP" : "DOWN",
            amount: 400,
            confidence: 0.9,
            reason: "Intent mentions scrolling and no interactive element scored highly enough to click.",
          },
        ],
        rationale: "No confident element match; scrolling to reveal more context.",
        confidence: 0.9,
      };
    }

    return {
      requestId: context.requestId,
      actions: [{ actionId: nextActionId(), type: "DONE", confidence: 1, reason: "No further matching action found for the stated intent." }],
      rationale: "No interactive element matched the intent well enough to act on; ending task.",
      confidence: 1,
    };
  }
}
