import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractDomElements } from "../../apps/extension/src/perception/dom/dom-extractor.js";
import { detectDomSensitivity } from "../../apps/extension/src/privacy/detectors/dom-detector.js";

const LOGIN_HTML = `
<!doctype html>
<html><body>
  <form>
    <label for="email">Email</label>
    <input id="email" type="email" name="email" autocomplete="email" />
    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" />
    <button type="submit">Login</button>
  </form>
</body></html>
`;

const MISSION_CONTROL_HTML = `
<!doctype html>
<html><body>
  <h1>Mission Control</h1>
  <button id="telemetry">Telemetry</button>
  <button id="payload">Payload</button>
  <p id="temp">Temperature: 42&deg;C</p>
  <p id="operator">Operator: John Doe</p>
</body></html>
`;

describe("DOM extractor (jsdom)", () => {
  it("extracts interactive login fields and flags email/password via the DOM detector", () => {
    const dom = new JSDOM(LOGIN_HTML);
    const { elements, domSignals } = extractDomElements(dom.window.document);

    const emailEl = elements.find((e) => e.inputType === "email");
    const passwordEl = elements.find((e) => e.inputType === "password");
    expect(emailEl).toBeDefined();
    expect(passwordEl).toBeDefined();

    const findings = detectDomSensitivity(domSignals, elements);
    const categories = findings.map((f) => f.category);
    expect(categories).toContain("EMAIL");
    expect(categories).toContain("PASSWORD");
  });

  it("extracts mission-control buttons as interactive and text blocks as non-interactive", () => {
    const dom = new JSDOM(MISSION_CONTROL_HTML);
    const { elements } = extractDomElements(dom.window.document);

    const telemetryBtn = elements.find((e) => e.text === "Telemetry");
    expect(telemetryBtn).toBeDefined();
    expect(telemetryBtn!.interactive).toBe(true);

    const operatorText = elements.find((e) => e.text?.includes("Operator"));
    expect(operatorText).toBeDefined();
    expect(operatorText!.interactive).toBe(false);
  });

  it("assigns stable ids that persist across a second extraction of the same DOM", () => {
    const dom = new JSDOM(MISSION_CONTROL_HTML);
    const first = extractDomElements(dom.window.document);
    const second = extractDomElements(dom.window.document);
    const firstBtn = first.elements.find((e) => e.text === "Telemetry")!;
    const secondBtn = second.elements.find((e) => e.text === "Telemetry")!;
    expect(firstBtn.id).toBe(secondBtn.id);
  });
});
