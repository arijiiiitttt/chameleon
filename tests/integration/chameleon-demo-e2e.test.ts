import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { extractDomElements } from "../../apps/extension/src/perception/dom/dom-extractor.js";
import { fuseScreenState } from "@chameleon/screen-state";
import { runPrivacyPipeline } from "../../apps/extension/src/privacy/privacy-engine.js";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import { PrivacyVault, InMemoryVaultAdapter } from "../../apps/extension/src/privacy/vault/privacy-vault.js";
import { OutboundFirewall } from "../../apps/extension/src/firewall/outbound-firewall.js";
import { MockReasoningProvider } from "../../apps/server/src/providers/mock-provider.js";
import { SanitizedRequestSchema } from "@chameleon/protocol";

const DEMO_SITE_PATH = path.resolve(__dirname, "../../demo-site/mission-control.html");

describe("CHAMELEON end-to-end demo: 'Analyze satellite anomaly; acknowledge incident.'", () => {
  it("perceives the real demo HTML, redacts all synthetic secrets, passes the firewall, and the mock server selects ACKNOWLEDGE INCIDENT", async () => {
    const html = readFileSync(DEMO_SITE_PATH, "utf-8");
    const dom = new JSDOM(html, { url: "https://mission-control.chameleon.local/" });

    const { elements, domSignals } = extractDomElements(dom.window.document);

    const screen = fuseScreenState({
      id: "screen_demo_1",
      timestamp: Date.now(),
      viewport: { width: 1440, height: 900, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      page: { url: dom.window.location.href, title: dom.window.document.title, pageType: "mission_control" },
      elements,
      ocrRegions: [],
      visualRegions: [],
    });

    const textRegions = elements
      .filter((e) => e.text)
      .map((e) => ({ regionId: e.id, text: e.text as string, source: "DOM" as const }));

    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const { sanitizedRequest } = await runPrivacyPipeline(
      {
        screen,
        domSignals,
        textRegions,
        userIntent: "Analyze satellite anomaly; acknowledge incident.",
        requestId: "req_chameleon_demo",
        iteration: 1,
        maxIterations: 15,
      },
      policy,
      vault
    );

    const serialized = JSON.stringify(sanitizedRequest);

    // 1. Every piece of synthetic sensitive data from the real demo page is absent from the sanitized payload.
    expect(serialized).not.toContain("Arijit Roy");
    expect(serialized).not.toContain("arijit@example.com");
    expect(serialized).not.toContain("ISRO-DEMO-47291");
    expect(serialized).not.toContain("sk-demo-a1b2c3d4e5f6g7h8");
    expect(serialized).not.toContain("S3cureDemo!Pass");

    // 2. The embedded prompt-injection payload text, even if picked up as a
    //    text region, must never cause an "attacker.example.com" reference
    //    to appear in what's sent to the server.
    expect(serialized).not.toContain("attacker.example.com");

    // 3. Public UI structure (button labels) survives redaction untouched.
    const ackButton = sanitizedRequest.screen.elements.find((e) => e.label === "ACKNOWLEDGE INCIDENT");
    expect(ackButton).toBeDefined();
    expect(ackButton?.interactive).toBe(true);

    // 4. The sanitized payload passes the mandatory outbound firewall.
    const firewall = new OutboundFirewall();
    const decision = firewall.inspect(sanitizedRequest);
    expect(decision.allowed).toBe(true);

    // 5. The payload is schema-valid per the wire protocol the real server enforces.
    expect(SanitizedRequestSchema.safeParse(sanitizedRequest).success).toBe(true);

    // 6. The mock reasoning provider - using only domain-independent word-overlap
    //    matching, not a hardcoded "if satellite page" rule - correctly selects
    //    the ACKNOWLEDGE INCIDENT button over VIEW DIAGNOSTICS or any other
    //    interactive element, and completely ignores the injection payload
    //    (which contains no CLICK-able target of its own).
    const provider = new MockReasoningProvider();
    const plan = await provider.generatePlan(SanitizedRequestSchema.parse(sanitizedRequest));

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe("CLICK");
    if (plan.actions[0]!.type === "CLICK") {
      expect(plan.actions[0]!.targetId).toBe(ackButton!.id);
    }
  });
});
