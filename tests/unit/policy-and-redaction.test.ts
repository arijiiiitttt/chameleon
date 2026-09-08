import { describe, it, expect } from "vitest";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import { PrivacyVault, InMemoryVaultAdapter } from "../../apps/extension/src/privacy/vault/privacy-vault.js";
import { redactText } from "../../apps/extension/src/redaction/text-redactor.js";
import { planBboxRedaction } from "../../apps/extension/src/redaction/bbox-redactor.js";

describe("PrivacyPolicyEngine", () => {
  it("defaults PASSWORD and OTP to BLOCK", () => {
    const engine = new PrivacyPolicyEngine();
    expect(engine.decide({ id: "1", category: "PASSWORD", confidence: 1, severity: "CRITICAL", sources: ["DOM"] })).toBe("BLOCK");
    expect(engine.decide({ id: "2", category: "OTP", confidence: 1, severity: "CRITICAL", sources: ["DOM"] })).toBe("BLOCK");
  });

  it("fails closed (MASK) for an unrecognized category rather than ALLOW", () => {
    const engine = new PrivacyPolicyEngine();
    // simulate a category missing from the table by stripping it
    engine.setPolicy({ OTHER: undefined as any });
    const decision = engine.decide({ id: "3", category: "OTHER", confidence: 1, severity: "LOW", sources: ["DOM"] });
    expect(decision).not.toBe("ALLOW");
  });
});

describe("Text redactor + vault", () => {
  it("tokenizes an email and never leaves the raw value in sanitized text", async () => {
    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const result = await redactText(
      {
        regionId: "r1",
        text: "Email: john@example.com",
        findings: [{ id: "f1", category: "EMAIL", textRange: { start: 7, end: 24 }, confidence: 0.97, severity: "MEDIUM", sources: ["REGEX"] }],
      },
      policy,
      vault
    );

    expect(result.sanitizedText).not.toContain("john@example.com");
    expect(result.sanitizedText).toMatch(/\[EMAIL_1\]/);

    const resolved = await vault.resolve("EMAIL_1");
    expect(resolved).toBe("john@example.com");
  });

  it("masks a password with a black-box placeholder and marks the payload as blocked", async () => {
    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const result = await redactText(
      {
        regionId: "r2",
        text: "Password: hunter2hunter2",
        findings: [{ id: "f2", category: "PASSWORD", textRange: { start: 10, end: 24 }, confidence: 0.99, severity: "CRITICAL", sources: ["DOM"] }],
      },
      policy,
      vault
    );

    expect(result.blocked).toBe(true);
    expect(result.sanitizedText).not.toContain("hunter2hunter2");
  });
});

describe("Bbox redaction planning", () => {
  it("plans a black box for a password field and a blur for a face", () => {
    const policy = new PrivacyPolicyEngine();
    const plan = planBboxRedaction(
      [
        { id: "f1", category: "PASSWORD", bbox: { x: 0, y: 0, width: 100, height: 20 }, confidence: 0.99, severity: "CRITICAL", sources: ["DOM"] },
        { id: "f2", category: "FACE", bbox: { x: 200, y: 200, width: 50, height: 50 }, confidence: 0.9, severity: "HIGH", sources: ["VISION"] },
      ],
      policy
    );

    expect(plan.find((r) => r.findingId === "f1")?.style).toBe("BLACK_BOX");
    expect(plan.find((r) => r.findingId === "f2")?.style).toBe("PIXELATE_BLUR");
  });
});
