/**
 * INLINED COPY, not a workspace dependency.
 *
 * This file is deliberately duplicated from packages/action-dsl/src/index.ts
 * rather than imported via the "@chameleon/action-dsl" workspace package,
 * so that `apps/server` is a fully self-contained deployable unit - you
 * can copy this directory alone (no monorepo root, no npm workspaces) to
 * a server, run `npm install && npm run build && npm start`, and it works.
 *
 * If you change the Action DSL, update BOTH this file and
 * packages/action-dsl/src/index.ts (used by the browser extension and the
 * root test suite) - see docs/DEPLOYMENT.md for why this tradeoff was
 * made and what keeping them in sync involves.
 */
import { z } from "zod";

/**
 * SECURITY INVARIANT:
 * The server may ONLY ever produce values that satisfy this schema.
 * There is no "EXECUTE_JAVASCRIPT", "EVAL", or "RAW_JS" variant, and none
 * may be added without also updating every validator that consumes this
 * type.
 */

const base = {
  actionId: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  reason: z.string().max(500).optional(),
};

export const ClickAction = z.object({ type: z.literal("CLICK"), targetId: z.string().min(1), ...base });
export const FocusAction = z.object({ type: z.literal("FOCUS"), targetId: z.string().min(1), ...base });

export const ScrollAction = z.object({
  type: z.literal("SCROLL"),
  direction: z.enum(["UP", "DOWN"]),
  amount: z.number().positive(),
  ...base,
});

export const TypeAction = z.object({
  type: z.literal("TYPE"),
  targetId: z.string().min(1),
  /**
   * valueToken points into the LOCAL privacy vault (e.g. "EMAIL_1"). The
   * server never sees or supplies the actual value - see
   * apps/extension/src/privacy/vault for resolution.
   */
  valueToken: z.string().min(1),
  ...base,
});

export const SelectAction = z.object({
  type: z.literal("SELECT"),
  targetId: z.string().min(1),
  option: z.string().min(1),
  ...base,
});

export const NavigateAction = z.object({ type: z.literal("NAVIGATE"), targetId: z.string().min(1), ...base });

export const WaitAction = z.object({
  type: z.literal("WAIT"),
  milliseconds: z.number().int().positive().max(10_000),
  ...base,
});

export const ExtractAction = z.object({
  type: z.literal("EXTRACT"),
  targetId: z.string().min(1),
  ...base,
});

export const DoneAction = z.object({ type: z.literal("DONE"), ...base });

export const RequestConfirmationAction = z.object({
  type: z.literal("REQUEST_CONFIRMATION"),
  targetId: z.string().min(1),
  message: z.string().max(500),
  ...base,
});

export const ActionSchema = z.discriminatedUnion("type", [
  ClickAction,
  FocusAction,
  ScrollAction,
  TypeAction,
  SelectAction,
  NavigateAction,
  WaitAction,
  ExtractAction,
  DoneAction,
  RequestConfirmationAction,
]);

export type Action = z.infer<typeof ActionSchema>;

export const ActionPlanSchema = z.object({
  requestId: z.string().min(1),
  actions: z.array(ActionSchema).max(20),
  rationale: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1),
});

export type ActionPlan = z.infer<typeof ActionPlanSchema>;

/** CHAMELEON's five-tier risk classification. */
export type RiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const HIGH_RISK_HINTS = ["delete", "submit", "send", "purchase", "payment", "pay", "checkout", "remove", "acknowledge"];
const CRITICAL_RISK_HINTS = ["confirm-account", "buy", "authorize-payment", "credential"];

/**
 * Classifies the intrinsic risk of an action independent of confidence.
 * SCROLL/FOCUS/WAIT/EXTRACT are always SAFE; CLICK/SELECT/TYPE depend on
 * the target's label; NAVIGATE is always at least HIGH (cross-origin
 * navigation risk is treated conservatively); REQUEST_CONFIRMATION and
 * DONE are themselves SAFE (they don't act on the page).
 */
export function classifyActionRisk(action: Action, targetLabel?: string): RiskLevel {
  const label = (targetLabel ?? "").toLowerCase();

  switch (action.type) {
    case "SCROLL":
    case "FOCUS":
    case "WAIT":
    case "EXTRACT":
    case "REQUEST_CONFIRMATION":
    case "DONE":
      return "SAFE";
    case "NAVIGATE":
      return "HIGH";
    case "TYPE":
      return "MEDIUM";
    case "CLICK":
    case "SELECT":
      if (CRITICAL_RISK_HINTS.some((h) => label.includes(h))) return "CRITICAL";
      if (HIGH_RISK_HINTS.some((h) => label.includes(h))) return "HIGH";
      return "LOW";
  }
}

export function isHighRisk(action: Action, targetLabel?: string): boolean {
  const risk = classifyActionRisk(action, targetLabel);
  return risk === "HIGH" || risk === "CRITICAL";
}

export interface ActionValidationResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
}

/**
 * Pure structural + policy validation that does not require DOM access.
 * The extension's ActionValidator (apps/extension/src/executor/action-validator.ts)
 * additionally re-checks this against the live DOM before execution.
 */
export function validateActionStructurally(
  candidate: unknown,
  confidenceThresholds: { auto: number; verify: number } = { auto: 0.9, verify: 0.7 }
): { action: Action | null; result: ActionValidationResult } {
  const parsed = ActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      action: null,
      result: { allowed: false, reason: "SCHEMA_VALIDATION_FAILED", requiresConfirmation: false },
    };
  }

  const action = parsed.data;

  if (action.confidence < confidenceThresholds.verify) {
    return {
      action,
      result: { allowed: false, reason: "CONFIDENCE_TOO_LOW", requiresConfirmation: false },
    };
  }

  const requiresConfirmation =
    action.confidence < confidenceThresholds.auto || isHighRisk(action);

  return {
    action,
    result: { allowed: true, requiresConfirmation },
  };
}
