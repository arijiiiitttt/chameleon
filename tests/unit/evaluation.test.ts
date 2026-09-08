import { describe, it, expect } from "vitest";
import { computePerCategoryMetrics, computeOverallMetrics } from "@chameleon/evaluation";
import { computeRedactionMetrics } from "@chameleon/evaluation";
import { iou } from "@chameleon/shared-types";

describe("PII precision/recall metrics", () => {
  it("computes correct TP/FP/FN and derived precision/recall/F1", () => {
    const groundTruth = [
      { id: "g1", category: "EMAIL" as const },
      { id: "g2", category: "EMAIL" as const },
      { id: "g3", category: "PHONE" as const },
    ];
    const predictions = [
      { id: "p1", category: "EMAIL" as const }, // matches g1
      { id: "p2", category: "EMAIL" as const }, // matches g2
      { id: "p3", category: "PHONE" as const }, // matches g3
      { id: "p4", category: "PERSON" as const }, // false positive, no ground truth
    ];

    const perCategory = computePerCategoryMetrics(groundTruth, predictions, () => true);
    const email = perCategory.find((c) => c.category === "EMAIL")!;
    expect(email.tp).toBe(2);
    expect(email.fp).toBe(0);
    expect(email.fn).toBe(0);
    expect(email.precision).toBe(1);
    expect(email.recall).toBe(1);

    const person = perCategory.find((c) => c.category === "PERSON")!;
    expect(person.fp).toBe(1);
    expect(person.precision).toBe(0);

    const overall = computeOverallMetrics(perCategory);
    expect(overall.tp).toBe(3);
    expect(overall.fp).toBe(1);
    expect(overall.fn).toBe(0);
  });

  it("counts a missed ground-truth item as a false negative", () => {
    const groundTruth = [{ id: "g1", category: "PASSWORD" as const }];
    const predictions: Array<{ id: string; category: "PASSWORD" }> = [];
    const perCategory = computePerCategoryMetrics(groundTruth, predictions, () => true);
    expect(perCategory[0]!.fn).toBe(1);
    expect(perCategory[0]!.recall).toBe(0);
  });
});

describe("IoU geometry", () => {
  it("computes 1.0 for identical boxes and 0 for disjoint boxes", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(iou(box, box)).toBe(1);
    expect(iou(box, { x: 100, y: 100, width: 10, height: 10 })).toBe(0);
  });
});

describe("Redaction metrics", () => {
  it("classifies correct, over-, and under-redactions correctly using IoU threshold", () => {
    const groundTruth = [
      { id: "g1", bbox: { x: 0, y: 0, width: 10, height: 10 } },   // will be correctly matched
      { id: "g2", bbox: { x: 100, y: 100, width: 10, height: 10 } }, // will be missed entirely (under-redaction)
    ];
    const predictions = [
      { id: "p1", bbox: { x: 0, y: 0, width: 10, height: 10 } },    // perfect match with g1
      { id: "p2", bbox: { x: 500, y: 500, width: 5, height: 5 } },  // matches nothing (false redaction)
    ];

    const result = computeRedactionMetrics(groundTruth, predictions, 0.5);
    expect(result.correctRedactions).toBe(1);
    expect(result.underRedactions).toBe(1);
    expect(result.falseRedactions).toBe(1);
    expect(result.averageIoU).toBeCloseTo(1, 5);
  });
});
