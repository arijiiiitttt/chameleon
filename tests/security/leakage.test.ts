import { describe, it, expect } from "vitest";
import { OutboundFirewall } from "../../apps/extension/src/firewall/outbound-firewall.js";

describe("Privacy Firewall - leakage test (spec section 21)", () => {
  const firewall = new OutboundFirewall();

  it("blocks a raw email attempting to leave the client", () => {
    const attemptedPayload = {
      message: "Send user email: john@example.com",
    };

    const decision = firewall.inspect(attemptedPayload);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("RAW_PII_DETECTED");
    }
  });

  it("blocks a raw password nested deep inside a request payload", () => {
    const attemptedPayload = {
      requestId: "req_1",
      screen: {
        elements: [
          { id: "e1", role: "text", metadata: { debug: { rawPassword: "hunter2hunter2" } } },
        ],
      },
    };

    const decision = firewall.inspect(attemptedPayload);
    expect(decision.allowed).toBe(false);
  });

  it("blocks a raw phone number and a raw 12-digit identifier hidden in an array", () => {
    const attemptedPayload = {
      logs: ["contact +919876543210 or aadhaar 1234 5678 9012 for details"],
    };

    const decision = firewall.inspect(attemptedPayload);
    expect(decision.allowed).toBe(false);
  });

  it("blocks any field that looks like a raw screenshot, even if PII-free", () => {
    const attemptedPayload = {
      screenshot: "data:image/png;base64,AAAA",
    };

    const decision = firewall.inspect(attemptedPayload);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("UNSANITIZED_SCREENSHOT_FIELD_DETECTED");
    }
  });

  it("still blocks a lookalike field name that merely CONTAINS 'screenshot' but isn't the exact sanctioned key", () => {
    // Guards against a naive "contains 'screenshot'" allowlist that would
    // accidentally let a maliciously- or carelessly-named field like this
    // one slip through - only the EXACT key name "redactedScreenshot" is
    // ever permitted (see leakage-detector.ts's ALLOWED_SCREENSHOT_KEY_NAMES).
    const attemptedPayload = {
      notRedactedScreenshotActually: "data:image/png;base64,AAAA",
    };

    const decision = firewall.inspect(attemptedPayload);
    expect(decision.allowed).toBe(false);
  });

  it("allows the exact-name 'redactedScreenshot' field (the sanctioned VLM channel), even with a large base64 payload that would otherwise coincidentally trip PHONE/CREDIT_CARD-shaped digit runs", () => {
    // A real base64 PNG/JPEG string, long enough that pure chance makes a
    // coincidental 10-19 digit run highly likely - this is the exact
    // false-positive scenario payload-scanner.ts's exact-name exemption
    // for this field exists to prevent.
    const fakeBase64Pixels = Array.from({ length: 2000 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[
        Math.floor(Math.random() * 64)
      ]
    ).join("");

    const sanitizedPayload = {
      schemaVersion: "1.0",
      requestId: "req_vlm_1",
      userIntent: "Open detailed telemetry",
      screen: {
        pageType: "mission_dashboard",
        elements: [{ id: "btn_telemetry", role: "button", label: "Telemetry", interactive: true, redacted: false }],
        redactedScreenshot: {
          dataUrl: `data:image/jpeg;base64,${fakeBase64Pixels}`,
          width: 480,
          height: 300,
        },
      },
      privacy: { sanitized: true, findings: 0, blocked: 0 },
    };

    const decision = firewall.inspect(sanitizedPayload);
    expect(decision.allowed).toBe(true);
  });

  it("allows a fully sanitized payload containing only tokens and public data", () => {
    const sanitizedPayload = {
      schemaVersion: "1.0",
      requestId: "req_123",
      userIntent: "Open detailed telemetry",
      screen: {
        pageType: "mission_dashboard",
        elements: [
          { id: "btn_telemetry", role: "button", label: "Telemetry", interactive: true, redacted: false },
          { id: "operator", role: "text", label: "[PERSON_1]", interactive: false, redacted: true },
          { id: "email", role: "text", label: "[EMAIL_1]", interactive: false, redacted: true },
          { id: "temperature", role: "text", label: "Temperature", value: "42\u00b0C", interactive: false, redacted: false },
        ],
      },
      privacy: { sanitized: true, findings: 4, blocked: 0 },
    };

    const decision = firewall.inspect(sanitizedPayload);
    expect(decision.allowed).toBe(true);
  });
});
