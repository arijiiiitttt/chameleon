import type { BoundingBox } from "@chameleon/shared-types";
import { iou } from "@chameleon/shared-types";

export interface RedactionGroundTruth {
  id: string;
  bbox: BoundingBox;
}

export interface RedactionPrediction {
  id: string;
  bbox: BoundingBox;
}

export interface RedactionMetricsResult {
  correctRedactions: number;
  overRedactions: number;
  underRedactions: number; // == missed PII (false negatives)
  falseRedactions: number; // predicted redaction with no overlapping ground truth
  averageIoU: number;
  precision: number;
  recall: number;
}

/**
 * IoU >= threshold counts as a "correct" redaction match.
 * Predictions whose best IoU with any ground-truth box is below threshold
 * but nonzero count as over-redaction (redacted more area than necessary,
 * or redacted the wrong region while still touching real PII).
 * Ground-truth boxes with no matching prediction at all count as under-redaction
 * (missed PII - the worst failure mode for this system).
 */
export function computeRedactionMetrics(
  groundTruth: RedactionGroundTruth[],
  predictions: RedactionPrediction[],
  threshold = 0.5
): RedactionMetricsResult {
  const usedGT = new Set<string>();
  const usedPred = new Set<string>();
  const ious: number[] = [];

  let correctRedactions = 0;
  let overRedactions = 0;

  for (const pred of predictions) {
    let bestIoU = 0;
    let bestGT: RedactionGroundTruth | null = null;
    for (const gt of groundTruth) {
      if (usedGT.has(gt.id)) continue;
      const overlap = iou(gt.bbox, pred.bbox);
      if (overlap > bestIoU) {
        bestIoU = overlap;
        bestGT = gt;
      }
    }

    if (bestGT && bestIoU >= threshold) {
      correctRedactions += 1;
      usedGT.add(bestGT.id);
      usedPred.add(pred.id);
      ious.push(bestIoU);
    } else if (bestGT && bestIoU > 0) {
      overRedactions += 1;
      usedPred.add(pred.id);
      ious.push(bestIoU);
    }
  }

  const underRedactions = groundTruth.filter((g) => !usedGT.has(g.id)).length;
  const falseRedactions = predictions.filter((p) => !usedPred.has(p.id)).length;

  const precision =
    predictions.length === 0 ? 0 : correctRedactions / predictions.length;
  const recall =
    groundTruth.length === 0 ? 0 : correctRedactions / groundTruth.length;
  const averageIoU = ious.length === 0 ? 0 : ious.reduce((a, b) => a + b, 0) / ious.length;

  return {
    correctRedactions,
    overRedactions,
    underRedactions,
    falseRedactions,
    averageIoU,
    precision,
    recall,
  };
}
