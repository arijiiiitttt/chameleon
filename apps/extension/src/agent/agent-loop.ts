import type { ScreenState } from "@chameleon/shared-types";
import type { SanitizedRequest, ActionPlanResponse } from "@chameleon/shared-types";
import { AgentStateMachine } from "./state-machine.js";
import { TaskManager } from "./task-manager.js";
import { OutboundFirewall } from "../firewall/outbound-firewall.js";
import { validateAction, type ActionValidationOutcome } from "../executor/action-validator.js";

export interface AgentLoopStatusSnapshot {
  agentState: string;
  iteration: number;
  /** Populated once sanitize() has run this iteration; undefined before that. */
  privacy?: { sensitiveDetected: number; redacted: number; blocked: number };
  /** Real, measured performance.now() deltas for stages completed so far this iteration. */
  timings: Record<string, number>;
  /** The most recently proposed action's confidence (0-1); null until a plan with at least one action has been received. */
  lastActionConfidence: number | null;
}

export interface AgentLoopDeps {
  /** Perceives the current page and returns a fresh ScreenState (capture -> DOM -> ARIA -> OCR -> vision -> fusion) */
  perceive: () => Promise<ScreenState>;
  /** Runs the full privacy pipeline (detect -> classify -> redact) and returns a sanitized wire request */
  sanitize: (screen: ScreenState, intent: string, iteration: number, maxIterations: number) => Promise<SanitizedRequest>;
  /** Calls the server reasoning provider with a sanitized request */
  callServer: (request: SanitizedRequest) => Promise<ActionPlanResponse>;
  /** Executes a single validated action against the real browser and returns the resulting outcome */
  execute: (action: unknown) => Promise<{ success: boolean; error?: string }>;
  /** Presents a confirmation prompt to the user for a high-risk/low-confidence action; resolves true/false */
  requestConfirmation: (action: unknown) => Promise<boolean>;
  firewall?: OutboundFirewall;
  /**
   * Optional real-time status reporter, called after each meaningful
   * stage transition with genuinely measured data (never fabricated) -
   * the content script wires this to `chrome.runtime.sendMessage` so the
   * popup's Judge Dashboard can show live confidence/privacy/timing
   * numbers. Purely additive: omitting it changes no control flow, which
   * is what keeps this loop's existing unit tests (which don't provide
   * one) valid unchanged.
   */
  onStatus?: (snapshot: AgentLoopStatusSnapshot) => void;
}

export interface AgentLoopResult {
  finalState: ReturnType<AgentStateMachine["getState"]>;
  iterations: number;
  stopReason: string | null;
  transitions: ReturnType<AgentStateMachine["getHistory"]>;
}

/**
 * Runs the ISRO-spec agent loop end to end. Every stage is a thin call into
 * an injected dependency so the control flow itself (ordering, state
 * transitions, fail-closed behavior on firewall block) can be unit tested
 * with mocks, independent of real browser/network/model integration.
 */
export async function runAgentLoop(intent: string, deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const machine = new AgentStateMachine();
  const task = new TaskManager(intent);
  const firewall = deps.firewall ?? new OutboundFirewall();

  task.start();
  machine.transition("OBSERVING");

  let expectedScreenId = "";
  let lastActionConfidence: number | null = null;

  while (!machine.isTerminal()) {
    const stop = task.checkStop();
    if (stop) {
      machine.transition("FAILED");
      return { finalState: machine.getState(), iterations: task.getIteration(), stopReason: stop, transitions: machine.getHistory() };
    }

    const iteration = task.nextIteration();
    const timings: Record<string, number> = {};

    machine.transition("PERCEIVING");
    let screen: ScreenState;
    const perceiveStart = performance.now();
    try {
      screen = await deps.perceive();
      expectedScreenId = screen.id;
    } catch {
      machine.transition("FAILED");
      break;
    }
    timings.perceive = performance.now() - perceiveStart;

    machine.transition("CLASSIFYING_PRIVACY");
    machine.transition("SANITIZING");
    let sanitizedRequest: SanitizedRequest;
    const sanitizeStart = performance.now();
    try {
      sanitizedRequest = await deps.sanitize(screen, intent, iteration, 15);
    } catch {
      machine.transition("BLOCKED");
      break;
    }
    timings.sanitize = performance.now() - sanitizeStart;

    deps.onStatus?.({
      agentState: machine.getState(),
      iteration,
      privacy: {
        sensitiveDetected: sanitizedRequest.privacy.findings,
        redacted: sanitizedRequest.privacy.redacted,
        blocked: sanitizedRequest.privacy.blocked,
      },
      timings: { ...timings },
      lastActionConfidence,
    });

    machine.transition("FIREWALL_CHECK");
    const decision = firewall.inspect(sanitizedRequest);
    if (!decision.allowed) {
      machine.transition("BLOCKED");
      break;
    }

    machine.transition("WAITING_FOR_SERVER");
    let plan: ActionPlanResponse;
    const serverStart = performance.now();
    try {
      plan = await deps.callServer(sanitizedRequest);
    } catch {
      machine.transition("FAILED");
      break;
    }
    timings.server = performance.now() - serverStart;

    machine.transition("PLANNING");
    if (plan.actions.length === 0) {
      machine.transition("COMPLETED");
      break;
    }

    const candidate = plan.actions[0];
    const candidateWithConfidence = candidate as { confidence?: unknown };
    lastActionConfidence =
      typeof candidateWithConfidence.confidence === "number" ? candidateWithConfidence.confidence : null;

    deps.onStatus?.({
      agentState: machine.getState(),
      iteration,
      privacy: {
        sensitiveDetected: sanitizedRequest.privacy.findings,
        redacted: sanitizedRequest.privacy.redacted,
        blocked: sanitizedRequest.privacy.blocked,
      },
      timings: { ...timings },
      lastActionConfidence,
    });

    machine.transition("VALIDATING_ACTION");
    const outcome: ActionValidationOutcome = validateAction(candidate, screen, expectedScreenId);

    if (outcome.status === "BLOCK") {
      machine.transition("BLOCKED");
      break;
    }

    if (outcome.status === "AWAITING_CONFIRMATION") {
      machine.transition("AWAITING_CONFIRMATION");
      const confirmed = await deps.requestConfirmation(outcome.action);
      if (!confirmed) {
        machine.transition("BLOCKED");
        break;
      }
    }

    machine.transition("EXECUTING");
    const execResult = await deps.execute(outcome.action);
    if (!execResult.success) {
      machine.transition("FAILED");
      break;
    }

    machine.transition("VERIFYING");
    machine.transition("OBSERVING");
  }

  return {
    finalState: machine.getState(),
    iterations: task.getIteration(),
    stopReason: null,
    transitions: machine.getHistory(),
  };
}
