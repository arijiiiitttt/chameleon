export type AgentState =
  | "IDLE"
  | "OBSERVING"
  | "PERCEIVING"
  | "CLASSIFYING_PRIVACY"
  | "SANITIZING"
  | "FIREWALL_CHECK"
  | "WAITING_FOR_SERVER"
  | "PLANNING"
  | "VALIDATING_ACTION"
  | "AWAITING_CONFIRMATION"
  | "EXECUTING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED";

const ALLOWED_TRANSITIONS: Record<AgentState, AgentState[]> = {
  IDLE: ["OBSERVING"],
  OBSERVING: ["PERCEIVING", "FAILED"],
  PERCEIVING: ["CLASSIFYING_PRIVACY", "FAILED"],
  CLASSIFYING_PRIVACY: ["SANITIZING", "FAILED"],
  SANITIZING: ["FIREWALL_CHECK", "BLOCKED", "FAILED"],
  FIREWALL_CHECK: ["WAITING_FOR_SERVER", "BLOCKED"],
  WAITING_FOR_SERVER: ["PLANNING", "FAILED"],
  PLANNING: ["VALIDATING_ACTION", "COMPLETED", "FAILED"],
  VALIDATING_ACTION: ["EXECUTING", "AWAITING_CONFIRMATION", "BLOCKED", "COMPLETED"],
  AWAITING_CONFIRMATION: ["EXECUTING", "BLOCKED"],
  EXECUTING: ["VERIFYING", "FAILED"],
  VERIFYING: ["OBSERVING", "COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: AgentState, to: AgentState) {
    super(`INVALID_TRANSITION: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export interface StateTransitionEvent {
  from: AgentState;
  to: AgentState;
  timestamp: number;
}

/**
 * Explicit, auditable state machine (spec section 32: "Do not build the
 * agent as uncontrolled recursive code"). Every transition is validated
 * against an allow-list; illegal transitions throw rather than silently
 * happening.
 */
export class AgentStateMachine {
  private current: AgentState = "IDLE";
  private history: StateTransitionEvent[] = [];

  getState(): AgentState {
    return this.current;
  }

  getHistory(): StateTransitionEvent[] {
    return [...this.history];
  }

  transition(to: AgentState): void {
    const allowed = ALLOWED_TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new InvalidTransitionError(this.current, to);
    }
    this.history.push({ from: this.current, to, timestamp: Date.now() });
    this.current = to;
  }

  isTerminal(): boolean {
    return this.current === "COMPLETED" || this.current === "FAILED" || this.current === "BLOCKED";
  }

  reset(): void {
    this.current = "IDLE";
    this.history = [];
  }
}