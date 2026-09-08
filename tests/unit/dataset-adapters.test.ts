import { describe, it, expect } from "vitest";
import { SyntheticPrivacyAdapter } from "../../datasets/adapters/synthetic-privacy-adapter.js";
import { ScreenSpotAdapter, Mind2WebAdapter, VisualWebArenaAdapter } from "../../datasets/adapters/open-source-adapters.js";
import manifest from "../../datasets/manifests/dataset_manifest.json" with { type: "json" };

describe("SyntheticPrivacyAdapter", () => {
  it("normalizes the synthetic pages into BenchmarkSample[] with real ground-truth PII annotations", async () => {
    const adapter = new SyntheticPrivacyAdapter();
    const samples = await adapter.load();

    expect(samples.length).toBeGreaterThanOrEqual(3);
    const missionControl = samples.find((s) => s.id === "mission_control");
    expect(missionControl).toBeDefined();
    expect(missionControl!.piiAnnotations.length).toBeGreaterThan(0);
    expect(missionControl!.piiAnnotations.some((a) => a.type === "EMAIL")).toBe(true);
    expect(missionControl!.domSnapshot).toContain("Mission Control");
  });
});

describe("Open-source dataset adapters (honestly not implemented)", () => {
  it("ScreenSpotAdapter throws NOT_IMPLEMENTED rather than returning fabricated samples", async () => {
    await expect(new ScreenSpotAdapter().load()).rejects.toThrow("NOT_IMPLEMENTED");
  });

  it("Mind2WebAdapter throws NOT_IMPLEMENTED rather than returning fabricated samples", async () => {
    await expect(new Mind2WebAdapter().load()).rejects.toThrow("NOT_IMPLEMENTED");
  });

  it("VisualWebArenaAdapter throws NOT_IMPLEMENTED rather than returning fabricated samples", async () => {
    await expect(new VisualWebArenaAdapter().load()).rejects.toThrow("NOT_IMPLEMENTED");
  });
});

describe("Dataset governance manifest", () => {
  it("declares every dataset referenced in code with a status field, and never claims ISRO's official evaluation set", () => {
    expect(manifest.datasets.length).toBeGreaterThan(0);
    for (const d of manifest.datasets) {
      expect(d.status === "implemented" || d.status === "not_implemented").toBe(true);
    }
    const names = manifest.datasets.map((d) => d.name.toLowerCase());
    expect(names).not.toContain("isro official evaluation set");
  });
});
