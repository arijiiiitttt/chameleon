import { describe, it, expect } from "vitest";
import { runPrivacyPipeline } from "../../apps/extension/src/privacy/privacy-engine.js";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import { PrivacyVault, InMemoryVaultAdapter } from "../../apps/extension/src/privacy/vault/privacy-vault.js";
import { MockReasoningProvider } from "../../apps/server/src/providers/mock-provider.js";
import { SanitizedRequestSchema } from "@chameleon/protocol";
import type { ScreenState } from "@chameleon/shared-types";

/**
 * Proves the vision layer's output is decision-relevant, not just used
 * for redaction (the gap identified against the PS brief's "reads the
 * screen and takes decisions based on that" requirement - see
 * docs/LIMITATIONS.md). Runs the REAL privacy pipeline (which now emits
 * `role: "region"` pseudo-elements for classified document/table/chart
 * regions) through the REAL MockReasoningProvider, and asserts the
 * resulting action plan is genuinely different depending on whether a
 * vision-classified region is present - not a mocked/stubbed
 * demonstration.
 */
function baseScreen(visualRegions: ScreenState["visualRegions"]): ScreenState {
  return {
    id: "s1",
    timestamp: Date.now(),
    viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    page: { url: "https://example.com", title: "Example" },
    elements: [], // no clickable/interactive elements at all - forces the planner past the CLICK branch
    visualRegions,
    ocrRegions: [],
    relations: [],
    privacyFindings: [],
    confidence: 1,
  };
}

describe("Vision-informed decisions: the local vision model's output changes what action the server proposes", () => {
  it("with NO visual region present, the planner has nothing to act on and returns DONE", async () => {
    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const { sanitizedRequest } = await runPrivacyPipeline(
      {
        screen: baseScreen([]),
        domSignals: [],
        textRegions: [],
        userIntent: "read the document on this page",
        requestId: "req_novision",
        iteration: 1,
        maxIterations: 5,
      },
      policy,
      vault
    );

    const parsed = SanitizedRequestSchema.parse(sanitizedRequest);
    const provider = new MockReasoningProvider();
    const plan = await provider.generatePlan(parsed);

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe("DONE");
  });

  it("with a real classified 'document' visual region present, the SAME intent produces an EXTRACT action instead", async () => {
    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const screen = baseScreen([
      {
        id: "scene_0",
        kind: "document",
        bbox: { x: 10, y: 10, width: 300, height: 400 },
        confidence: 0.91,
        backend: "wasm",
        sourceElementId: "visimg_1", // as image-scan-service.ts would assign for a <canvas>
      },
    ]);

    const { sanitizedRequest } = await runPrivacyPipeline(
      {
        screen,
        domSignals: [],
        textRegions: [],
        userIntent: "read the document on this page",
        requestId: "req_withvision",
        iteration: 1,
        maxIterations: 5,
      },
      policy,
      vault
    );

    // The sanitized payload must carry the region as a non-interactive,
    // non-PII pseudo-element - confirms the wiring, not just the outcome.
    const regionElement = sanitizedRequest.screen.elements.find((e) => e.role === "region");
    expect(regionElement).toBeDefined();
    expect(regionElement!.id).toBe("visimg_1");
    expect(regionElement!.label).toBe("Document region");
    expect(regionElement!.interactive).toBe(false);

    const parsed = SanitizedRequestSchema.parse(sanitizedRequest);
    const provider = new MockReasoningProvider();
    const plan = await provider.generatePlan(parsed);

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe("EXTRACT");
    expect((plan.actions[0] as { targetId: string }).targetId).toBe("visimg_1");
  });

  it("a FACE region never becomes an actionable target (redaction-only, by design)", async () => {
    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const screen = baseScreen([
      {
        id: "face_0",
        kind: "face",
        bbox: { x: 5, y: 5, width: 50, height: 50 },
        confidence: 0.95,
        backend: "wasm",
        sourceElementId: "visimg_2",
      },
    ]);

    const { sanitizedRequest } = await runPrivacyPipeline(
      {
        screen,
        domSignals: [],
        textRegions: [],
        userIntent: "look at the face in the photo",
        requestId: "req_face",
        iteration: 1,
        maxIterations: 5,
      },
      policy,
      vault
    );

    expect(sanitizedRequest.screen.elements.some((e) => e.role === "region")).toBe(false);
  });

  it("an <img>-sourced region (id collision with an existing DOM element) enriches that element's label instead of duplicating it", async () => {
    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const screen: ScreenState = {
      ...baseScreen([
        {
          id: "scene_1",
          kind: "table",
          bbox: { x: 0, y: 0, width: 200, height: 150 },
          confidence: 0.8,
          backend: "wasm",
          sourceElementId: "el_5", // collides with a real DOM-extracted element id below
        },
      ]),
      elements: [
        {
          id: "el_5",
          role: "image",
          text: undefined,
          ariaLabel: "Quarterly figures",
          interactive: false,
          visible: true,
          enabled: true,
          confidence: 1,
          bbox: { x: 0, y: 0, width: 200, height: 150 },
        },
      ],
    };

    const { sanitizedRequest } = await runPrivacyPipeline(
      {
        screen,
        domSignals: [],
        textRegions: [],
        userIntent: "check the table",
        requestId: "req_imgcollision",
        iteration: 1,
        maxIterations: 5,
      },
      policy,
      vault
    );

    const el = sanitizedRequest.screen.elements.find((e) => e.id === "el_5");
    expect(el).toBeDefined();
    expect(el!.label).toContain("Data table region");
    expect(sanitizedRequest.screen.elements.filter((e) => e.id === "el_5")).toHaveLength(1); // no duplicate
  });
});
