export interface ConfidenceThresholds {
  auto: number; // >= this: execute automatically
  verify: number; // between verify and auto: require confirmation; below: reject/re-perceive
}

const DEFAULT: ConfidenceThresholds = { auto: 0.9, verify: 0.7 };

export class ConfidenceManager {
  private thresholds: ConfidenceThresholds;

  constructor(thresholds: ConfidenceThresholds = DEFAULT) {
    this.thresholds = thresholds;
  }

  getThresholds(): ConfidenceThresholds {
    return { ...this.thresholds };
  }

  setThresholds(next: Partial<ConfidenceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...next };
  }

  classify(confidence: number): "AUTO" | "VERIFY" | "REJECT" {
    if (confidence >= this.thresholds.auto) return "AUTO";
    if (confidence >= this.thresholds.verify) return "VERIFY";
    return "REJECT";
  }
}
