import { describe, it, expect } from "vitest";
import { detectRegexSensitivity } from "../../apps/extension/src/privacy/detectors/regex-detector.js";
import { detectDomSensitivity } from "../../apps/extension/src/privacy/detectors/dom-detector.js";

describe("CHAMELEON extended taxonomy - regex detector", () => {
  it("detects a synthetic OpenAI-style API key", () => {
    const findings = detectRegexSensitivity([
      { regionId: "r1", text: "API Token: sk-demo-abcdef1234567890", source: "DOM" },
    ]);
    expect(findings.some((f) => f.category === "API_KEY")).toBe(true);
  });

  it("detects a JWT-shaped access token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const findings = detectRegexSensitivity([{ regionId: "r2", text: `Bearer ${jwt}`, source: "DOM" }]);
    expect(findings.some((f) => f.category === "ACCESS_TOKEN")).toBe(true);
  });

  it("detects an ISRO-style employee id", () => {
    const findings = detectRegexSensitivity([
      { regionId: "r3", text: "Employee ID: ISRO-DEMO-47291", source: "DOM" },
    ]);
    expect(findings.some((f) => f.category === "EMPLOYEE_ID")).toBe(true);
  });

  it("detects a US-style street address line", () => {
    const findings = detectRegexSensitivity([
      { regionId: "r4", text: "Ship to: 742 Evergreen Terrace, Springfield", source: "DOM" },
    ]);
    expect(findings.some((f) => f.category === "ADDRESS")).toBe(true);
  });

  it("detects a US ZIP+4 code and a state+ZIP suffix", () => {
    const zipPlus4 = detectRegexSensitivity([{ regionId: "r5", text: "Mail code: 94105-1234", source: "DOM" }]);
    expect(zipPlus4.some((f) => f.category === "ADDRESS")).toBe(true);

    const stateZip = detectRegexSensitivity([
      { regionId: "r6", text: "123 Main Street, San Francisco, CA 94105", source: "DOM" },
    ]);
    expect(stateZip.filter((f) => f.category === "ADDRESS").length).toBeGreaterThanOrEqual(1);
  });

  it("detects a label-anchored Indian PIN code but not a bare 6-digit number", () => {
    const labeled = detectRegexSensitivity([
      { regionId: "r7", text: "Pincode: 560001, Bengaluru", source: "DOM" },
    ]);
    expect(labeled.some((f) => f.category === "ADDRESS")).toBe(true);

    const bare = detectRegexSensitivity([{ regionId: "r8", text: "Order number 560001 confirmed", source: "DOM" }]);
    expect(bare.some((f) => f.category === "ADDRESS")).toBe(false);
  });
});

describe("CHAMELEON extended taxonomy - DOM detector", () => {
  it("flags a field named employeeId as EMPLOYEE_ID", () => {
    const findings = detectDomSensitivity([{ elementId: "e1", name: "employeeId" }], []);
    expect(findings[0]?.category).toBe("EMPLOYEE_ID");
  });

  it("flags a field named apiKey as API_KEY", () => {
    const findings = detectDomSensitivity([{ elementId: "e2", name: "apiKey" }], []);
    expect(findings[0]?.category).toBe("API_KEY");
  });
});
