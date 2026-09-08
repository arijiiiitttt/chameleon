import { describe, it, expect } from "vitest";
import { detectDomSensitivity } from "../../apps/extension/src/privacy/detectors/dom-detector.js";
import { detectRegexSensitivity } from "../../apps/extension/src/privacy/detectors/regex-detector.js";
import { HeuristicNerDetector } from "../../apps/extension/src/privacy/detectors/ner-detector.js";
import { classifyFindings } from "../../apps/extension/src/privacy/classifier/privacy-classifier.js";

describe("DOM detector", () => {
  it("flags a password input as PASSWORD with high confidence", () => {
    const findings = detectDomSensitivity(
      [{ elementId: "pw", inputType: "password" }],
      [{ id: "pw", role: "textbox", bbox: { x: 0, y: 0, width: 10, height: 10 }, visible: true, enabled: true, interactive: true, confidence: 1 }]
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("PASSWORD");
    expect(findings[0]!.confidence).toBeGreaterThan(0.9);
  });

  it("does not flag an ordinary text input with no sensitive hints", () => {
    const findings = detectDomSensitivity(
      [{ elementId: "search", inputType: "text", name: "search-query" }],
      []
    );
    expect(findings).toHaveLength(0);
  });
});

describe("Regex detector", () => {
  it("detects an email address in OCR-sourced text", () => {
    const findings = detectRegexSensitivity([
      { regionId: "r1", text: "Email: john@example.com", source: "OCR" },
    ]);
    expect(findings.some((f) => f.category === "EMAIL")).toBe(true);
  });

  it("detects an Indian mobile number", () => {
    const findings = detectRegexSensitivity([
      { regionId: "r2", text: "Phone: +919876543210", source: "DOM" },
    ]);
    expect(findings.some((f) => f.category === "PHONE")).toBe(true);
  });
});

describe("Heuristic NER detector", () => {
  it("detects a label-anchored person name with high confidence", () => {
    const detector = new HeuristicNerDetector();
    const findings = detector.detect([{ regionId: "r3", text: "Operator: John Doe", source: "OCR" }]);
    const person = findings.find((f) => f.confidence > 0.8);
    expect(person).toBeDefined();
    expect(person!.category).toBe("PERSON");
  });
});

describe("Privacy classifier", () => {
  it("boosts confidence when DOM and regex detectors agree on the same span", () => {
    const merged = classifyFindings([
      { id: "a", category: "EMAIL", textRange: { start: 0, end: 16 }, confidence: 0.9, severity: "MEDIUM", sources: ["DOM"] },
      { id: "b", category: "EMAIL", textRange: { start: 0, end: 16 }, confidence: 0.8, severity: "MEDIUM", sources: ["REGEX"] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.confidence).toBeGreaterThan(0.9);
    expect(merged[0]!.sources).toEqual(expect.arrayContaining(["DOM", "REGEX"]));
  });

  it("keeps non-overlapping findings separate", () => {
    const merged = classifyFindings([
      { id: "a", category: "EMAIL", textRange: { start: 0, end: 5 }, confidence: 0.9, severity: "MEDIUM", sources: ["DOM"] },
      { id: "b", category: "PHONE", textRange: { start: 10, end: 20 }, confidence: 0.8, severity: "MEDIUM", sources: ["REGEX"] },
    ]);
    expect(merged).toHaveLength(2);
  });
});
