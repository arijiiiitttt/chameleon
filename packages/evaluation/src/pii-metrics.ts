import type { SensitivityType } from "@chameleon/shared-types";

export interface GroundTruthItem {
  id: string;
  category: SensitivityType;
}

export interface PredictedItem {
  id: string;
  category: SensitivityType;
  /** id of the ground-truth item this prediction matches, if any (set by the matcher) */
  matchedGroundTruthId?: string;
}

export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface CategoryMetrics extends ConfusionCounts {
  category: SensitivityType;
  precision: number;
  recall: number;
  f1: number;
}

function safeDiv(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

/**
 * Matches predictions to ground truth by (category, and optional bbox/text overlap
 * supplied by the caller via `isMatch`). Any ground-truth item that never gets
 * matched is a false negative; any prediction that matches nothing is a false positive.
 */
export function matchPredictions<G extends GroundTruthItem, P extends PredictedItem>(
  groundTruth: G[],
  predictions: P[],
  isMatch: (g: G, p: P) => boolean
): { matched: Array<{ groundTruth: G; prediction: P }>; falsePositives: P[]; falseNegatives: G[] } {
  const usedGroundTruth = new Set<string>();
  const usedPredictions = new Set<string>();
  const matched: Array<{ groundTruth: G; prediction: P }> = [];

  for (const p of predictions) {
    for (const g of groundTruth) {
      if (usedGroundTruth.has(g.id)) continue;
      if (g.category !== p.category) continue;
      if (!isMatch(g, p)) continue;
      usedGroundTruth.add(g.id);
      usedPredictions.add(p.id);
      matched.push({ groundTruth: g, prediction: p });
      break;
    }
  }

  const falsePositives = predictions.filter((p) => !usedPredictions.has(p.id));
  const falseNegatives = groundTruth.filter((g) => !usedGroundTruth.has(g.id));

  return { matched, falsePositives, falseNegatives };
}

export function computeCategoryMetrics(
  category: SensitivityType,
  tp: number,
  fp: number,
  fn: number
): CategoryMetrics {
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  return { category, tp, fp, fn, precision, recall, f1 };
}

export function computePerCategoryMetrics<G extends GroundTruthItem, P extends PredictedItem>(
  groundTruth: G[],
  predictions: P[],
  isMatch: (g: G, p: P) => boolean
): CategoryMetrics[] {
  const categories = new Set<SensitivityType>([
    ...groundTruth.map((g) => g.category),
    ...predictions.map((p) => p.category),
  ]);

  const results: CategoryMetrics[] = [];
  for (const category of categories) {
    const gtForCat = groundTruth.filter((g) => g.category === category);
    const predForCat = predictions.filter((p) => p.category === category);
    const { matched, falsePositives, falseNegatives } = matchPredictions(
      gtForCat,
      predForCat,
      isMatch
    );
    results.push(
      computeCategoryMetrics(category, matched.length, falsePositives.length, falseNegatives.length)
    );
  }
  return results.sort((a, b) => a.category.localeCompare(b.category));
}

export function computeOverallMetrics(perCategory: CategoryMetrics[]): CategoryMetrics {
  const tp = perCategory.reduce((s, c) => s + c.tp, 0);
  const fp = perCategory.reduce((s, c) => s + c.fp, 0);
  const fn = perCategory.reduce((s, c) => s + c.fn, 0);
  return computeCategoryMetrics("OTHER", tp, fp, fn);
}
