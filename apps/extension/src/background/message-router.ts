export interface AgentStatusMessage {
  type: "AGENT_STATUS";
  client: {
    localVision: "READY" | "LOADING" | "UNAVAILABLE";
    ocr: "READY" | "LOADING" | "UNAVAILABLE";
    privacyEngine: "ACTIVE" | "INACTIVE";
    firewall: "ACTIVE" | "INACTIVE";
    actionValidator: "ACTIVE" | "INACTIVE";
  };
  server: {
    api: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
    provider: string;
  };
  privacy: {
    rawPiiSent: number;
    sensitiveDetected: number;
    redacted: number;
    blocked: number;
  };
  performance: {
    totalMs: number;
    timings: Record<string, number>;
  };
  agentState: string;
  /**
   * The most recently proposed action's confidence (0-1, the same scale
   * every Action DSL schema already validates - see packages/action-dsl),
   * for display as a percentage in the popup. `null` before any action
   * has been proposed yet in the current task (e.g. still perceiving/
   * sanitizing) - the popup must render "—" or similar for null, never
   * fabricate a number for a stage that hasn't produced one.
   */
  lastActionConfidence: number | null;
}

export type RuntimeMessage =
  | { type: "REQUEST_STATUS" }
  | AgentStatusMessage
  | { type: "START_TASK"; intent: string }
  | { type: "CANCEL_TASK" }
  | { type: "CAPTURE_VISIBLE_TAB" }
  | { type: "CAPTURE_VISIBLE_TAB_RESULT"; dataUrl: string | null; error?: string };

/**
 * Central message router for the extension's three contexts (popup,
 * background, content script). Every inbound message is validated against
 * this discriminated union before being acted on - the background never
 * trusts an unvalidated message shape (spec section 54).
 */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
