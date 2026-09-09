export interface TaskLimits {
  maxIterations: number;
  timeoutMs: number;
}

const DEFAULT_LIMITS: TaskLimits = { maxIterations: 15, timeoutMs: 300_000 };

export type TaskStopReason = "MAX_ITERATIONS" | "TIMEOUT" | "CANCELLED" | null;

/**
 * Tracks a single agent task's lifecycle and enforces the hard stop
 * conditions required by spec section 33 ("Never create an infinite
 * autonomous loop").
 */
export class TaskManager {
  private startedAt = 0;
  private iteration = 0;
  private cancelled = false;
  private limits: TaskLimits;
  public readonly intent: string;

  constructor(intent: string, limits: TaskLimits = DEFAULT_LIMITS) {
    this.intent = intent;
    this.limits = limits;
  }

  start(): void {
    this.startedAt = Date.now();
    this.iteration = 0;
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
  }

  nextIteration(): number {
    this.iteration += 1;
    return this.iteration;
  }

  getIteration(): number {
    return this.iteration;
  }

  checkStop(): TaskStopReason {
    if (this.cancelled) return "CANCELLED";
    if (this.iteration >= this.limits.maxIterations) return "MAX_ITERATIONS";
    if (Date.now() - this.startedAt >= this.limits.timeoutMs) return "TIMEOUT";
    return null;
  }
}