import { describe, it, expect } from "vitest";
import {
  StubImageOcrService,
  TesseractOcrService,
  createOcrService,
  makeOcrRegion,
} from "../../apps/extension/src/perception/ocr/ocr-service.js";
import {
  FallbackVisionModel,
  OnnxFaceVisionModel,
  createLocalVisionModel,
} from "../../apps/extension/src/models/local-vision-model.js";
import {
  FallbackSceneClassifierModel,
  OnnxSceneClassifierModel,
  createSceneClassifierModel,
  SCENE_CLASSES,
} from "../../apps/extension/src/models/scene-classifier-model.js";
import { detectVisionSensitivity } from "../../apps/extension/src/privacy/detectors/vision-detector.js";
import { runPrivacyPipeline } from "../../apps/extension/src/privacy/privacy-engine.js";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import { PrivacyVault, InMemoryVaultAdapter } from "../../apps/extension/src/privacy/vault/privacy-vault.js";
import type { ScreenState, VisualRegion } from "@chameleon/shared-types";

const dummyImageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData;

describe("OCR service", () => {
  it("StubImageOcrService truthfully returns empty results, never fabricates text", async () => {
    const stub = new StubImageOcrService();
    const result = await stub.recognize(dummyImageData, 1, 1);
    expect(result).toEqual([]);
  });

  // TesseractOcrService itself spins up a real tesseract.js worker that
  // fetches WASM/traineddata over the network - exercising it for real
  // requires a browser (or at least network access + worker_threads) and
  // is out of scope for a fast, deterministic Node unit test, consistent
  // with how this repo already treats other browser-only integrations
  // (see LIMITATIONS.md §6). Its class shape/exports are still
  // covered by the typecheck; `createOcrService()` below verifies the
  // Node fallback path, which is the path unit tests actually exercise.
  it("TesseractOcrService is exported and constructible (real network/worker path is browser-only, see LIMITATIONS.md)", () => {
    expect(() => new TesseractOcrService()).not.toThrow();
  });

  it("createOcrService() picks the honest stub in a non-browser (no Worker/document) environment", () => {
    const service = createOcrService();
    expect(service).toBeInstanceOf(StubImageOcrService);
  });

  it("makeOcrRegion builds a well-formed OCRRegion", () => {
    const region = makeOcrRegion("r1", "hello", { x: 0, y: 0, width: 10, height: 10 }, 0.9);
    expect(region).toEqual({ id: "r1", text: "hello", bbox: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9 });
  });
});

describe("Local vision model", () => {
  it("FallbackVisionModel requires initialize() and then reports backend unavailable with zero regions", async () => {
    const model = new FallbackVisionModel();
    await expect(model.analyze({ imageData: dummyImageData, width: 1, height: 1 })).rejects.toThrow(
      "MODEL_INITIALIZATION_FAILED"
    );
    await model.initialize();
    const result = await model.analyze({ imageData: dummyImageData, width: 1, height: 1 });
    expect(result).toEqual({ regions: [], backendUsed: "unavailable", inferenceMs: 0 });
  });

  it("OnnxFaceVisionModel fails closed to backendUsed 'unavailable' with zero regions when no model file is provisioned", async () => {
    const model = new OnnxFaceVisionModel({ modelUrl: "does-not-exist.onnx" });
    await model.initialize(); // never throws, even though both EPs fail to load the missing file
    const result = await model.analyze({ imageData: dummyImageData, width: 100, height: 100 });
    expect(result.backendUsed).toBe("unavailable");
    expect(result.regions).toEqual([]);
    await model.dispose();
  });

  it("real bundled ONNX model: loads for real and runs real inference (no mocking) - regression guard against the model file silently going missing", async () => {
    const model = new OnnxFaceVisionModel({
      modelUrl: "apps/extension/public/models/face-detector-rfb320.onnx",
    });
    await model.initialize();

    // A neutral gray 320x240 frame - not expected to contain a face, but
    // this asserts the SESSION ITSELF loaded and ran real inference
    // (backendUsed must be a real EP, not "unavailable"), which is the
    // property that changed: previously this always returned
    // "unavailable" no matter what. Detection *accuracy* on a real photo
    // was independently verified against this exact model+preprocessing
    // math outside the test suite (see MODEL_PIPELINE.md) - this test
    // guards against the wiring regressing, not against model accuracy.
    const width = 320;
    const height = 240;
    const gray = new Uint8ClampedArray(width * height * 4).fill(128);
    const imageData = { data: gray, width, height } as unknown as ImageData;

    const result = await model.analyze({ imageData, width, height });

    expect(result.backendUsed).not.toBe("unavailable");
    expect(["webgpu", "wasm", "cpu"]).toContain(result.backendUsed);
    expect(Array.isArray(result.regions)).toBe(true);
    expect(result.inferenceMs).toBeGreaterThanOrEqual(0);

    await model.dispose();
  });

  it("createLocalVisionModel() picks the honest fallback in a non-browser (no document) environment", () => {
    const model = createLocalVisionModel();
    expect(model).toBeInstanceOf(FallbackVisionModel);
  });
});

describe("Scene classifier (real trained Vision Transformer)", () => {
  it("FallbackSceneClassifierModel requires initialize() and then reports no label / backend unavailable", async () => {
    const model = new FallbackSceneClassifierModel();
    await expect(model.classify({ imageData: dummyImageData, width: 1, height: 1 })).rejects.toThrow(
      "MODEL_INITIALIZATION_FAILED"
    );
    await model.initialize();
    const result = await model.classify({ imageData: dummyImageData, width: 1, height: 1 });
    expect(result).toEqual({ label: null, confidence: 0, backendUsed: "unavailable", inferenceMs: 0 });
  });

  it("OnnxSceneClassifierModel fails closed when no model file is provisioned", async () => {
    const model = new OnnxSceneClassifierModel({ modelUrl: "does-not-exist.onnx" });
    await model.initialize();
    const result = await model.classify({ imageData: dummyImageData, width: 32, height: 32 });
    expect(result.backendUsed).toBe("unavailable");
    expect(result.label).toBeNull();
    await model.dispose();
  });

  it(
    "real bundled ONNX model correctly classifies a synthetic table-grid pattern as 'table' - " +
      "exercises the actual trained ViT end to end (not just documented separately in " +
      "tools/vit-training/verify_parity.py)",
    async () => {
      const model = new OnnxSceneClassifierModel({
        modelUrl: "apps/extension/public/models/screen-region-vit.onnx",
      });
      await model.initialize();

      // 32x32 grid pattern matching the training distribution's "table"
      // class (light background, evenly spaced horizontal + vertical
      // lines) - see tools/vit-training/synthetic_data.py's make_table().
      const size = 32;
      const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
      for (let i = 0; i < size * size; i++) {
        rgba[i * 4] = 245;
        rgba[i * 4 + 1] = 245;
        rgba[i * 4 + 2] = 245;
      }
      const shade = 90;
      const rowYs = [0, 8, 16, 24, 31];
      const colXs = [0, 11, 21, 31];
      for (const y of rowYs) {
        for (let x = 0; x < size; x++) {
          const idx = (y * size + x) * 4;
          rgba[idx] = rgba[idx + 1] = rgba[idx + 2] = shade;
        }
      }
      for (const x of colXs) {
        for (let y = 0; y < size; y++) {
          const idx = (y * size + x) * 4;
          rgba[idx] = rgba[idx + 1] = rgba[idx + 2] = shade;
        }
      }
      const imageData = { data: rgba, width: size, height: size } as unknown as ImageData;

      const result = await model.classify({ imageData, width: size, height: size });

      expect(result.backendUsed).not.toBe("unavailable");
      expect(SCENE_CLASSES).toContain(result.label);
      expect(result.label).toBe("table");
      expect(result.confidence).toBeGreaterThan(0.6);

      await model.dispose();
    }
  );

  it("createSceneClassifierModel() picks the honest fallback in a non-browser (no document) environment", () => {
    const model = createSceneClassifierModel();
    expect(model).toBeInstanceOf(FallbackSceneClassifierModel);
  });
});

describe("Vision detector", () => {
  it("maps a real face detection to a FACE finding", () => {
    const regions: VisualRegion[] = [
      { id: "f1", kind: "face", bbox: { x: 10, y: 10, width: 40, height: 40 }, confidence: 0.92, backend: "wasm" },
    ];
    const findings = detectVisionSensitivity(regions);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("FACE");
    expect(findings[0]!.sources).toEqual(["VISION"]);
  });

  it("maps a document region to DOCUMENT and ignores unmapped kinds like button-like", () => {
    const regions: VisualRegion[] = [
      { id: "d1", kind: "document", bbox: { x: 0, y: 0, width: 100, height: 100 }, confidence: 0.8, backend: "webgpu" },
      { id: "b1", kind: "button-like", bbox: { x: 0, y: 0, width: 20, height: 20 }, confidence: 0.9, backend: "webgpu" },
    ];
    const findings = detectVisionSensitivity(regions);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("DOCUMENT");
  });

  it("produces no findings when backendUsed is unavailable (matches the fail-closed vision model contract)", () => {
    const regions: VisualRegion[] = [
      { id: "f1", kind: "face", bbox: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.99, backend: "unavailable" },
    ];
    expect(detectVisionSensitivity(regions)).toEqual([]);
  });

  it("maps the scene classifier's 'table' kind to DOCUMENT and 'image' kind to OTHER, ignores 'chart'/'code'", () => {
    const regions: VisualRegion[] = [
      { id: "t1", kind: "table", bbox: { x: 0, y: 0, width: 50, height: 50 }, confidence: 0.9, backend: "wasm" },
      { id: "i1", kind: "image", bbox: { x: 0, y: 0, width: 50, height: 50 }, confidence: 0.75, backend: "wasm" },
      { id: "c1", kind: "chart", bbox: { x: 0, y: 0, width: 50, height: 50 }, confidence: 0.99, backend: "wasm" },
    ];
    const findings = detectVisionSensitivity(regions);
    expect(findings).toHaveLength(2);
    const byId = Object.fromEntries(findings.map((f) => [f.id, f.category]));
    expect(byId["vision_t1"]).toBe("DOCUMENT");
    expect(byId["vision_i1"]).toBe("OTHER");
    expect(byId["vision_c1"]).toBeUndefined(); // chart is not privacy-relevant, no finding
  });
});

describe("Privacy pipeline consumes vision + OCR output", () => {
  it("a FACE visual region produces a privacy finding and a bbox image-redaction plan", async () => {
    const screen: ScreenState = {
      id: "s1",
      timestamp: Date.now(),
      viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      page: { url: "https://example.com", title: "Example" },
      elements: [],
      visualRegions: [
        { id: "face_0", kind: "face", bbox: { x: 5, y: 5, width: 50, height: 50 }, confidence: 0.95, backend: "wasm" },
      ],
      ocrRegions: [],
      relations: [],
      privacyFindings: [],
      confidence: 1,
    };

    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const { sanitizedRequest, imageRedactionRegions } = await runPrivacyPipeline(
      {
        screen,
        domSignals: [],
        textRegions: [],
        userIntent: "test",
        requestId: "req_1",
        iteration: 1,
        maxIterations: 5,
      },
      policy,
      vault
    );

    expect(sanitizedRequest.privacy.findings).toBe(1);
    expect(imageRedactionRegions).toHaveLength(1);
    expect(imageRedactionRegions[0]!.style).toBe("PIXELATE_BLUR"); // FACE -> BLUR policy action
  });

  it("OCR-sourced text carrying an email is detected exactly like DOM text", async () => {
    const screen: ScreenState = {
      id: "s2",
      timestamp: Date.now(),
      viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      page: { url: "https://example.com", title: "Example" },
      elements: [],
      visualRegions: [],
      ocrRegions: [{ id: "ocr_1", text: "Contact: john@example.com", bbox: { x: 0, y: 0, width: 100, height: 20 }, confidence: 0.85 }],
      relations: [],
      privacyFindings: [],
      confidence: 1,
    };

    const policy = new PrivacyPolicyEngine();
    const vault = new PrivacyVault(new InMemoryVaultAdapter());

    const { sanitizedRequest } = await runPrivacyPipeline(
      {
        screen,
        domSignals: [],
        textRegions: [{ regionId: "ocr_1", text: "Contact: john@example.com", source: "OCR" }],
        userIntent: "test",
        requestId: "req_2",
        iteration: 1,
        maxIterations: 5,
      },
      policy,
      vault
    );

    expect(sanitizedRequest.privacy.findings).toBeGreaterThanOrEqual(1);
  });
});
