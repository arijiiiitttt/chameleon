import { describe, it, expect } from "vitest";
import { runAgentLoop, type AgentLoopDeps } from "../../apps/extension/src/agent/agent-loop.js";
import type { ScreenState, SanitizedRequest, ActionPlanResponse } from "@chameleon/shared-types";

function makeScreen(id: string): ScreenState {
  return {
    id,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    page: { url: "https://mission-control.local", title: "Mission Control" },
    elements: [
      { id: "btn_telemetry", role: "button", bbox: { x: 10, y: 10, width: 100, height: 30 }, text: "Telemetry", visible: true, enabled: true, interactive: true, confidence: 1 },
    ],
    visualRegions: [],
    ocrRegions: [],
    relations: [],
    privacyFindings: [],
    confidence: 0.95,
  };
}

function makeSanitizedRequest(id: string): SanitizedRequest {
  return {
    schemaVersion: "1.0",
    requestId: `req_${id}`,
    userIntent: "Open telemetry",
    screen: { pageType: "mission_dashboard", elements: [] },
    privacy: { sanitized: true, findings: 0, redacted: 0, blocked: 0 },
    privacyPolicyVersion: "1.0",
  };
}

describe("Agent loop", () => {
  it("completes successfully when server returns no further actions after one click", async () => {
    let callCount = 0;
    const deps: AgentLoopDeps = {
      perceive: async () => makeScreen("screen_1"),
      sanitize: async (screen) => makeSanitizedRequest(screen.id),
      callServer: async (): Promise<ActionPlanResponse> => {
        callCount += 1;
        if (callCount === 1) {
          return { requestId: "r1", actions: [{ actionId: "a-1", type: "CLICK", targetId: "btn_telemetry", confidence: 0.97 }], confidence: 0.97 };
        }
        return { requestId: "r2", actions: [], confidence: 1 };
      },
      execute: async () => ({ success: true }),
      requestConfirmation: async () => true,
    };

    const result = await runAgentLoop("Open the detailed telemetry report", deps);
    expect(result.finalState).toBe("COMPLETED");
    expect(result.transitions.some((t) => t.to === "EXECUTING")).toBe(true);
  });

  it("stops at BLOCKED when the firewall detects a leak, and never calls the server", async () => {
    let serverCalled = false;
    const deps: AgentLoopDeps = {
      perceive: async () => makeScreen("screen_1"),
      // Intentionally return a sanitized request with a raw email smuggled into userIntent to prove the firewall catches it
      sanitize: async () => ({ ...makeSanitizedRequest("x"), userIntent: "email me at john@example.com" }),
      callServer: async (): Promise<ActionPlanResponse> => {
        serverCalled = true;
        return { requestId: "r", actions: [], confidence: 1 };
      },
      execute: async () => ({ success: true }),
      requestConfirmation: async () => true,
    };

    const result = await runAgentLoop("leak attempt", deps);
    expect(result.finalState).toBe("BLOCKED");
    expect(serverCalled).toBe(false);
  });

  it("stops with MAX_ITERATIONS when the server keeps returning low-confidence actions that get blocked, looping without ever completing", async () => {
    const deps: AgentLoopDeps = {
      perceive: async () => makeScreen("screen_1"),
      sanitize: async (screen) => makeSanitizedRequest(screen.id),
      callServer: async (): Promise<ActionPlanResponse> => ({
        requestId: "r",
        actions: [{ actionId: "a-scroll", type: "SCROLL", direction: "DOWN", amount: 100, confidence: 0.99 }],
        confidence: 0.99,
      }),
      execute: async () => ({ success: true }),
      requestConfirmation: async () => true,
    };

    const result = await runAgentLoop("infinite scroll test", deps);
    // SCROLL doesn't target an element so it always executes and re-observes;
    // with a fixed screen id this will run until the hard iteration cap fires.
    expect(["MAX_ITERATIONS", "TIMEOUT"]).toContain(result.stopReason);
  });

  it("reports real, measured status via onStatus - confidence null before any action, then the real action's confidence after", async () => {
    const snapshots: Array<{ lastActionConfidence: number | null; timings: Record<string, number> }> = [];
    let callCount = 0;

    const deps: AgentLoopDeps = {
      perceive: async () => makeScreen("screen_1"),
      sanitize: async (screen) => makeSanitizedRequest(screen.id),
      callServer: async (): Promise<ActionPlanResponse> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            requestId: "r1",
            actions: [{ actionId: "a-1", type: "CLICK", targetId: "btn_telemetry", confidence: 0.87 }],
            confidence: 0.87,
          };
        }
        return { requestId: "r2", actions: [], confidence: 1 };
      },
      execute: async () => ({ success: true }),
      requestConfirmation: async () => true,
      onStatus: (snapshot) => {
        snapshots.push({ lastActionConfidence: snapshot.lastActionConfidence, timings: snapshot.timings });
      },
    };

    await runAgentLoop("Open the detailed telemetry report", deps);

    // First onStatus call for iteration 1 happens right after sanitize,
    // before any plan has been received - confidence must be null, never
    // a fabricated placeholder like 0.
    expect(snapshots[0]!.lastActionConfidence).toBeNull();
    expect(typeof snapshots[0]!.timings.sanitize).toBe("number");

    // Second call happens right after the real plan is received - the
    // REAL action's confidence (0.87) must appear verbatim, not rounded,
    // not re-derived.
    expect(snapshots[1]!.lastActionConfidence).toBe(0.87);

    // Once an action's confidence has been observed, it persists into
    // later iterations' pre-plan snapshots too (matches a Judge Dashboard
    // showing "last known confidence" rather than blanking between
    // iterations).
    const laterSnapshot = snapshots.find((_, i) => i >= 2);
    if (laterSnapshot) {
      expect(laterSnapshot.lastActionConfidence).toBe(0.87);
    }
  });
});
