import { describe, it, expect } from "vitest";
import { ActionSchema, validateActionStructurally, isHighRisk, classifyActionRisk } from "@chameleon/action-dsl";

describe("Action DSL schema", () => {
  it("accepts a well-formed CLICK action", () => {
    const parsed = ActionSchema.safeParse({ actionId: "a-1", type: "CLICK", targetId: "acknowledge_42", confidence: 0.97 });
    expect(parsed.success).toBe(true);
  });

  it("accepts DONE and REQUEST_CONFIRMATION actions", () => {
    expect(ActionSchema.safeParse({ actionId: "a-2", type: "DONE", confidence: 1 }).success).toBe(true);
    expect(
      ActionSchema.safeParse({ actionId: "a-3", type: "REQUEST_CONFIRMATION", targetId: "submit_btn", message: "Submit?", confidence: 1 })
        .success
    ).toBe(true);
  });

  it("rejects an action type outside the allowed DSL (e.g. an injected EXECUTE_JAVASCRIPT)", () => {
    const parsed = ActionSchema.safeParse({ actionId: "a-4", type: "EXECUTE_JAVASCRIPT", code: "alert(1)" });
    expect(parsed.success).toBe(false);
  });

  it("rejects TYPE actions missing a valueToken", () => {
    const parsed = ActionSchema.safeParse({ actionId: "a-5", type: "TYPE", targetId: "email_input" });
    expect(parsed.success).toBe(false);
  });
});

describe("Structural + confidence validation", () => {
  it("auto-allows a high-confidence click with no confirmation needed", () => {
    const { result } = validateActionStructurally({ actionId: "a-6", type: "CLICK", targetId: "view_diagnostics", confidence: 0.97 });
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("requires confirmation for a mid-confidence action (0.7-0.9)", () => {
    const { result } = validateActionStructurally({ actionId: "a-7", type: "CLICK", targetId: "btn_x", confidence: 0.8 });
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it("rejects a low-confidence action outright (<0.7)", () => {
    const { result } = validateActionStructurally({ actionId: "a-8", type: "CLICK", targetId: "btn_x", confidence: 0.5 });
    expect(result.allowed).toBe(false);
  });

  it("always requires confirmation for NAVIGATE regardless of confidence (HIGH risk by classification)", () => {
    const { result } = validateActionStructurally({ actionId: "a-9", type: "NAVIGATE", targetId: "external_link", confidence: 0.99 });
    expect(result.requiresConfirmation).toBe(true);
  });

  it("flags a click on an 'Acknowledge Incident' button as high-risk", () => {
    const action = ActionSchema.parse({ actionId: "a-10", type: "CLICK", targetId: "acknowledge_42", confidence: 0.95 });
    expect(isHighRisk(action, "Acknowledge Incident")).toBe(true);
  });
});

describe("Five-tier risk classification", () => {
  it("classifies SCROLL/FOCUS/WAIT/EXTRACT/DONE as SAFE", () => {
    expect(classifyActionRisk(ActionSchema.parse({ actionId: "r1", type: "SCROLL", direction: "DOWN", amount: 100, confidence: 1 }))).toBe("SAFE");
    expect(classifyActionRisk(ActionSchema.parse({ actionId: "r2", type: "FOCUS", targetId: "x", confidence: 1 }))).toBe("SAFE");
    expect(classifyActionRisk(ActionSchema.parse({ actionId: "r3", type: "WAIT", milliseconds: 500, confidence: 1 }))).toBe("SAFE");
    expect(classifyActionRisk(ActionSchema.parse({ actionId: "r4", type: "DONE", confidence: 1 }))).toBe("SAFE");
  });

  it("classifies TYPE as MEDIUM and a plain CLICK as LOW", () => {
    expect(
      classifyActionRisk(ActionSchema.parse({ actionId: "r5", type: "TYPE", targetId: "x", valueToken: "EMAIL_1", confidence: 1 }))
    ).toBe("MEDIUM");
    expect(classifyActionRisk(ActionSchema.parse({ actionId: "r6", type: "CLICK", targetId: "x", confidence: 1 }), "View Diagnostics")).toBe(
      "LOW"
    );
  });

  it("classifies a click on a payment/credential-flavored label as CRITICAL", () => {
    const action = ActionSchema.parse({ actionId: "r7", type: "CLICK", targetId: "x", confidence: 1 });
    expect(classifyActionRisk(action, "Authorize-Payment")).toBe("CRITICAL");
  });
});
