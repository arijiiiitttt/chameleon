import type { Action } from "@chameleon/action-dsl";
import { validateActionStructurally, isHighRisk } from "@chameleon/action-dsl";
import type { ScreenElement, ScreenState } from "@chameleon/shared-types";

export type ActionValidationOutcome =
  | { status: "EXECUTE"; action: Action }
  | { status: "AWAITING_CONFIRMATION"; action: Action; reason: string }
  | { status: "ALREADY_SATISFIED"; reason: string }
  | { status: "BLOCK"; reason: string };

export interface ValidatorThresholds {
  auto: number;
  verify: number;
}

const DEFAULT_THRESHOLDS: ValidatorThresholds = { auto: 0.9, verify: 0.7 };

function findElement(screenState: ScreenState, elementId: string): ScreenElement | undefined {
  return screenState.elements.find((e) => e.id === elementId);
}

/**
 * Re-validates a server-proposed action against the CURRENT local
 * ScreenState. This is the last line of defense before execution - the
 * server's plan is never trusted blindly (spec section 28, INVARIANT 6).
 */
export function validateAction(
  candidate: unknown,
  currentScreen: ScreenState,
  expectedScreenId: string,
  thresholds: ValidatorThresholds = DEFAULT_THRESHOLDS
): ActionValidationOutcome {
  const { action, result } = validateActionStructurally(candidate, thresholds);

  if (!action) {
    return { status: "BLOCK", reason: result.reason ?? "INVALID_ACTION" };
  }

  if (currentScreen.id !== expectedScreenId) {
    return { status: "BLOCK", reason: "STALE_SCREEN" };
  }

  if (!result.allowed) {
    return { status: "BLOCK", reason: result.reason ?? "REJECTED" };
  }

  // Target-based actions must resolve against the live screen.
  if (action.type === "CLICK" || action.type === "TYPE" || action.type === "SELECT" || action.type === "FOCUS" || action.type === "EXTRACT") {
    const element = findElement(currentScreen, action.targetId);
    if (!element) return { status: "BLOCK", reason: "TARGET_NOT_FOUND" };
    if (!element.visible) return { status: "BLOCK", reason: "ELEMENT_NOT_VISIBLE" };
    if (!element.enabled) {
      // A disabled CLICK target is only a real problem if the task's
      // goal isn't already met. Re-runs against a page that was already
      // acted on in a previous run (e.g. "ACKNOWLEDGE INCIDENT" already
      // clicked, now correctly disabled to prevent double-submission)
      // shouldn't be reported as a blocked failure - the intended
      // end-state is already true, so this is success, not a problem.
      const alreadyDoneText = (element.text ?? element.ariaLabel ?? "").toLowerCase();
      const looksAlreadyDone = /acknowledged|done|completed|resolved|✓/i.test(alreadyDoneText);
      if (action.type === "CLICK" && looksAlreadyDone) {
        return { status: "ALREADY_SATISFIED", reason: `TARGET_ALREADY_IN_DESIRED_STATE: ${alreadyDoneText}` };
      }
      return { status: "BLOCK", reason: "ELEMENT_NOT_ENABLED" };
    }
    if (action.type !== "EXTRACT" && !element.interactive) return { status: "BLOCK", reason: "ELEMENT_NOT_INTERACTIVE" };

    if (result.requiresConfirmation || isHighRisk(action, element.text ?? element.ariaLabel)) {
      return { status: "AWAITING_CONFIRMATION", action, reason: "HIGH_RISK_OR_LOW_CONFIDENCE" };
    }
  } else if (result.requiresConfirmation) {
    return { status: "AWAITING_CONFIRMATION", action, reason: "HIGH_RISK_OR_LOW_CONFIDENCE" };
  }

  return { status: "EXECUTE", action };
}