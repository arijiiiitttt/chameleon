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
  let lastPrivacy: AgentLoopStatusSnapshot["privacy"];

  // Emits a status snapshot immediately on every single state-machine
  // transition (not just at two checkpoints). This is what keeps the
  // popup/overlay showing continuous, live progress for the *whole*
  // duration of a stage - including slow ones like perceive()/execute()
  // that can take a while - instead of appearing frozen between the old
  // checkpoints. iteration/timings/privacy/confidence are always the
  // most recently known real values; nothing here is fabricated.
  const emit = (iteration: number, timings: Record<string, number>) => {
    deps.onStatus?.({
      agentState: machine.getState(),
      iteration,
      privacy: lastPrivacy,
      timings: { ...timings },
      lastActionConfidence,
    });
  };

  while (!machine.isTerminal()) {
    const stop = task.checkStop();
    if (stop) {
      console.error(`[CHAMELEON] Agent loop stopped: ${stop}`);
      machine.transition("FAILED");
      emit(task.getIteration(), {});
      return { finalState: machine.getState(), iterations: task.getIteration(), stopReason: stop, transitions: machine.getHistory() };
    }

    const iteration = task.nextIteration();
    const timings: Record<string, number> = {};

    // Machine is already in OBSERVING here - either from the initial
    // transition before the loop, or from the OBSERVING transition at
    // the end of the previous iteration below. Emit once so a poller
    // sees this stage too, without re-transitioning into the same state
    // (which the state machine correctly rejects as invalid).
    emit(iteration, timings);

    machine.transition("PERCEIVING");
    emit(iteration, timings);
    let screen: ScreenState;
    const perceiveStart = performance.now();
    try {
      screen = await deps.perceive();
      expectedScreenId = screen.id;
    } catch (err) {
      // Previously this swallowed the real error entirely (bare `catch {}`),
      // which is why the console showed nothing even though the loop
      // failed - you'd see "FAILED" in the UI with zero diagnostic trail.
      console.error("[CHAMELEON] perceive() failed:", err);
      machine.transition("FAILED");
      emit(iteration, timings);
      break;
    }
    timings.perceive = performance.now() - perceiveStart;

    machine.transition("CLASSIFYING_PRIVACY");
    emit(iteration, timings);

    machine.transition("SANITIZING");
    emit(iteration, timings);
    let sanitizedRequest: SanitizedRequest;
    const sanitizeStart = performance.now();
    try {
      sanitizedRequest = await deps.sanitize(screen, intent, iteration, 15);
    } catch (err) {
      console.error("[CHAMELEON] sanitize() failed:", err);
      machine.transition("BLOCKED");
      emit(iteration, timings);
      break;
    }
    timings.sanitize = performance.now() - sanitizeStart;
    lastPrivacy = {
      sensitiveDetected: sanitizedRequest.privacy.findings,
      redacted: sanitizedRequest.privacy.redacted,
      blocked: sanitizedRequest.privacy.blocked,
    };
    emit(iteration, timings);

    machine.transition("FIREWALL_CHECK");
    emit(iteration, timings);
    const decision = firewall.inspect(sanitizedRequest);
    if (!decision.allowed) {
      console.warn("[CHAMELEON] Firewall blocked request:", decision.reason);
      machine.transition("BLOCKED");
      emit(iteration, timings);
      break;
    }

    machine.transition("WAITING_FOR_SERVER");
    emit(iteration, timings);
    let plan: ActionPlanResponse;
    const serverStart = performance.now();
    try {
      plan = await deps.callServer(sanitizedRequest);
    } catch (err) {
      console.error("[CHAMELEON] callServer() failed:", err);
      machine.transition("FAILED");
      emit(iteration, timings);
      break;
    }
    timings.server = performance.now() - serverStart;

    machine.transition("PLANNING");
    if (plan.actions.length === 0) {
      machine.transition("COMPLETED");
      emit(iteration, timings);
      break;
    }

    const candidate = plan.actions[0];
    const candidateWithConfidence = candidate as { confidence?: unknown };
    lastActionConfidence =
      typeof candidateWithConfidence.confidence === "number" ? candidateWithConfidence.confidence : null;
    emit(iteration, timings);

    machine.transition("VALIDATING_ACTION");
    emit(iteration, timings);
    const outcome: ActionValidationOutcome = validateAction(candidate, screen, expectedScreenId);

    if (outcome.status === "BLOCK") {
      console.warn(`[CHAMELEON] Action validation blocked the action: ${outcome.reason}`, outcome);
      machine.transition("BLOCKED");
      emit(iteration, timings);
      break;
    }

    if (outcome.status === "ALREADY_SATISFIED") {
      console.log(`[CHAMELEON] Task goal already satisfied: ${outcome.reason}`);
      machine.transition("COMPLETED");
      emit(iteration, timings);
      break;
    }

    if (outcome.status === "AWAITING_CONFIRMATION") {
      machine.transition("AWAITING_CONFIRMATION");
      emit(iteration, timings);
      const confirmed = await deps.requestConfirmation(outcome.action);
      if (!confirmed) {
        machine.transition("BLOCKED");
        emit(iteration, timings);
        break;
      }
    }

    machine.transition("EXECUTING");
    emit(iteration, timings);
    const execResult = await deps.execute(outcome.action);
    if (!execResult.success) {
      console.error("[CHAMELEON] execute() failed:", execResult.error ?? "(no error message)");
      machine.transition("FAILED");
      emit(iteration, timings);
      break;
    }

    machine.transition("VERIFYING");
    emit(iteration, timings);

    machine.transition("OBSERVING");
    // Emitted at the top of the next loop iteration.
  }

  return {
    finalState: machine.getState(),
    iterations: task.getIteration(),
    stopReason: null,
    transitions: machine.getHistory(),
  };
}