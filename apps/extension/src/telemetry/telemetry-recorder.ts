export type PipelineStage =
  | "captureTime"
  | "domTime"
  | "ariaTime"
  | "ocrTime"
  | "visionTime"
  | "fusionTime"
  | "privacyTime"
  | "redactionTime"
  | "firewallTime"
  | "serializationTime"
  | "networkTime"
  | "serverTime"
  | "validationTime"
  | "executionTime"
  | "verificationTime";

export type StageTimings = Partial<Record<PipelineStage, number>>;

export interface TelemetrySnapshot {
  timings: StageTimings;
  totalTime: number;
  payloadSizeBytes?: number;
  modelBackend?: string;
}

/**
 * Records wall-clock durations for each named pipeline stage. All values
 * are actual `performance.now()` deltas - never fabricated (spec sections
 * 72, 83). Use `time()` to wrap an async stage automatically.
 */
export class TelemetryRecorder {
  private timings: StageTimings = {};
  private payloadSizeBytes?: number;
  private modelBackend?: string;

  async time<T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const elapsed = performance.now() - start;
      this.timings[stage] = (this.timings[stage] ?? 0) + elapsed;
    }
  }

  record(stage: PipelineStage, ms: number): void {
    this.timings[stage] = (this.timings[stage] ?? 0) + ms;
  }

  setPayloadSize(bytes: number): void {
    this.payloadSizeBytes = bytes;
  }

  setModelBackend(backend: string): void {
    this.modelBackend = backend;
  }

  snapshot(): TelemetrySnapshot {
    const totalTime = Object.values(this.timings).reduce((sum, v) => sum + (v ?? 0), 0);
    return {
      timings: { ...this.timings },
      totalTime,
      payloadSizeBytes: this.payloadSizeBytes,
      modelBackend: this.modelBackend,
    };
  }

  reset(): void {
    this.timings = {};
    this.payloadSizeBytes = undefined;
    this.modelBackend = undefined;
  }
}
