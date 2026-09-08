import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { extractDomElements } from "../../apps/extension/src/perception/dom/dom-extractor.js";
import { fuseScreenState } from "@chameleon/screen-state";
import { runPrivacyPipeline } from "../../apps/extension/src/privacy/privacy-engine.js";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import { PrivacyVault, InMemoryVaultAdapter } from "../../apps/extension/src/privacy/vault/privacy-vault.js";
import { OutboundFirewall } from "../../apps/extension/src/firewall/outbound-firewall.js";

const MISSION_CONTROL_HTML = `
<!doctype html>
<html><body>
  <h1>Mission Control</h1>
  <button id="telemetry">Telemetry</button>
  <button id="payload">Payload</button>
  <p id="temp">Temperature: 42 C</p>
  <p id="operator">Operator: John Doe</p>
  <p id="email">Email: john@example.com</p>
</body></html>
`;

const LOGIN_HTML = `
<!doctype html>
<html><body>
  <form>
    <input id="email" type="email" name="email" autocomplete="email" value="john@example.com" />
    <input id="password" type="password" name="password" autocomplete="current-password" value="hunter2hunter2" />
    <button type="submit">Login</button>
  </form>
</body></html>
`;

async function runPipelineFor(html: string, userIntent: string) {
  const dom = new JSDOM(html);
  const { elements, domSignals } = extractDomElements(dom.window.document);

  const screen = fuseScreenState({
    id: "screen_1",
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    page: { url: "https://mission-control.local", title: "Mission Control", pageType: "mission_dashboard" },
    elements,
    ocrRegions: [],
    visualRegions: [],
  });

  const textRegions = elements
    .filter((e) => e.text)
    .map((e) => ({ regionId: e.id, text: e.text as string, source: "DOM" as const }));

  const policy = new PrivacyPolicyEngine();
  const vault = new PrivacyVault(new InMemoryVaultAdapter());

  const output = await runPrivacyPipeline(
    {
      screen,
      domSignals,
      textRegions,
      userIntent,
      requestId: "req_e2e_1",
      iteration: 1,
      maxIterations: 15,
    },
    policy,
    vault
  );

  return { output, vault };
}

describe("End-to-end privacy pipeline (mission control + login demos)", () => {
  it("mission-control demo: redacts operator/email but keeps public telemetry data, and the sanitized payload passes the firewall", async () => {
    const { output } = await runPipelineFor(MISSION_CONTROL_HTML, "Open the detailed telemetry report");

    const serialized = JSON.stringify(output.sanitizedRequest);
    expect(serialized).not.toContain("John Doe");
    expect(serialized).not.toContain("john@example.com");

    const telemetryLabel = output.sanitizedRequest.screen.elements.find((e) => e.role === "button" && e.label === "Telemetry")?.label;
    expect(telemetryLabel).toBe("Telemetry"); // public UI structure passes through unredacted

    const firewall = new OutboundFirewall();
    const decision = firewall.inspect(output.sanitizedRequest);
    expect(decision.allowed).toBe(true);
  });

  it("login demo: password and email are tokenized/blocked, never appear in the sanitized payload, and firewall allows the sanitized result", async () => {
    const { output, vault } = await runPipelineFor(LOGIN_HTML, "Fill the login form");

    const serialized = JSON.stringify(output.sanitizedRequest);
    expect(serialized).not.toContain("hunter2hunter2");
    expect(serialized).not.toContain("john@example.com");

    // The raw password must still be resolvable LOCALLY via the vault (for local typing), just never serialized outward.
    const passwordToken = output.manifest.entries.find((e) => e.category === "PASSWORD")?.token;
    // PASSWORD policy is BLOCK by default, so it may not produce a token - verify it was at least handled, not leaked.
    if (passwordToken) {
      const resolved = await vault.resolve(passwordToken);
      expect(resolved).toBe("hunter2hunter2");
    }

    const firewall = new OutboundFirewall();
    const decision = firewall.inspect(output.sanitizedRequest);
    expect(decision.allowed).toBe(true);
  });
});
