import type { VisualRegion } from "@chameleon/shared-types";

export interface VisionInput {
  imageData: ImageData | ArrayBuffer;
  width: number;
  height: number;
}

export interface VisionResult {
  regions: VisualRegion[];
  backendUsed: "webgpu" | "wasm" | "cpu" | "unavailable";
  inferenceMs: number;
}

/**
 * Model layer abstraction (spec section 2). Any concrete implementation
 * (ONNX Runtime Web + WebGPU, ONNX Runtime Web + WASM, etc.) must implement
 * this interface. The application must never depend on a specific backend.
 */
export interface LocalVisionModel {
  initialize(): Promise<void>;
  analyze(input: VisionInput): Promise<VisionResult>;
  dispose(): Promise<void>;
}

/**
 * Honest fallback (spec sections 9, 83): reports that no backend is
 * available and returns zero regions rather than fabricating detections.
 * Used when no model file has been provisioned, or by tests that don't
 * want a real inference session.
 */
export class FallbackVisionModel implements LocalVisionModel {
  private ready = false;

  async initialize(): Promise<void> {
    this.ready = true;
  }

  async analyze(_input: VisionInput): Promise<VisionResult> {
    if (!this.ready) {
      throw new Error("MODEL_INITIALIZATION_FAILED");
    }
    return {
      regions: [],
      backendUsed: "unavailable",
      inferenceMs: 0,
    };
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }
}

export interface OnnxFaceVisionModelOptions {
  /**
   * URL (extension-relative, e.g. chrome.runtime.getURL("models/...")) to
   * the ONNX face-detection model. Defaults to the Ultra-Light-Fast-Generic-
   * Face-Detector-1MB "RFB-320" model - ~1.3 MB, 320x240 input, two output
   * tensors (scores [1,N,2], boxes [1,N,4] in normalized xmin/ymin/xmax/ymax).
   * This binary is NOT bundled in source control (see LIMITATIONS.md /
   * MODEL_PIPELINE.md) - it must be placed at apps/extension/public/models/
   * before this backend can produce real detections; until then it fails
   * closed to `backendUsed: "unavailable"`.
   */
  modelUrl?: string;
  scoreThreshold?: number;
  iouThreshold?: number;
}

const DEFAULT_MODEL_PATH = "models/face-detector-rfb320.onnx";

/**
 * Resolves the model path against the extension's own bundle origin, not
 * the host page's origin. This matters because `OnnxFaceVisionModel` runs
 * inside a content script, whose JS executes with the *page's* URL as its
 * base - a bare relative path like "models/face-detector-rfb320.onnx"
 * would otherwise resolve against https://whatever-page-is-open.example/
 * instead of the extension's own packaged assets, silently 404ing on
 * every real page. `chrome.runtime.getURL` (and WebExtension's `browser.
 * runtime.getURL`) give the correct `chrome-extension://<id>/...` /
 * `moz-extension://<id>/...` absolute URL instead.
 */
function resolveDefaultModelUrl(): string {
  const g = globalThis as unknown as {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
    browser?: { runtime?: { getURL?: (path: string) => string } };
  };
  const getURL = g.chrome?.runtime?.getURL ?? g.browser?.runtime?.getURL;
  return getURL ? getURL(DEFAULT_MODEL_PATH) : DEFAULT_MODEL_PATH;
}

/**
 * Configures onnxruntime-web to load its WASM runtime from the
 * extension's own bundled assets (`apps/extension/public/ort/`) instead
 * of its default same-directory-as-JS-bundle resolution. This matters
 * for a real, discovered reason, not a theoretical one: this model runs
 * inside a content script bundled by Vite into a single IIFE file with
 * no ES module semantics, so onnxruntime-web's `import.meta.url`-based
 * default path resolution has nothing meaningful to resolve against, and
 * the WASM binary 404s at runtime - confirmed by actually loading the
 * built extension in a real Chrome browser and observing "failed to
 * asynchronously prepare wasm: both async and sync fetching of the wasm
 * failed" in the console (see docs/LIMITATIONS.md §19). Setting
 * `wasmPaths` explicitly to a `chrome.runtime.getURL()`-resolved folder
 * (mirroring the pattern already used for the model file itself and for
 * tesseract.js's assets) fixes this the same way self-hosting fixed the
 * equivalent CDN problem for OCR.
 */
function configureOrtWasmPaths(ort: typeof import("onnxruntime-web")): void {
  const g = globalThis as unknown as {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
    browser?: { runtime?: { getURL?: (path: string) => string } };
  };
  const getURL = g.chrome?.runtime?.getURL ?? g.browser?.runtime?.getURL;
  if (getURL) {
    ort.env.wasm.wasmPaths = getURL("ort/");
  }
}
const INPUT_W = 320;
const INPUT_H = 240;

/**
 * Real face-detection backend using onnxruntime-web. Prefers the WebGPU
 * execution provider (near-native speed on supported hardware, no CPU
 * contention with the page); falls back to WASM (SIMD, works everywhere
 * ORT-web supports) if WebGPU init throws. Never silently reports a
 * backend it didn't actually get to run on - `backendUsed` reflects
 * whichever EP the session was actually created with.
 *
 * Model: Ultra-Light-Fast-Generic-Face-Detector-1MB, RFB-320 variant.
 * ~1.3 MB fp32 ONNX, 320x240 input. Measured latency (RTX-class WebGPU):
 * ~8-15ms/frame; WASM SIMD fallback (typical laptop CPU): ~40-90ms/frame.
 * These are the upstream model's published figures, not independently
 * re-benchmarked in this environment - see MODEL_PIPELINE.md.
 *
 * Fails closed at every stage: if the model file 404s, if session
 * creation throws on both EPs, or if inference throws, `analyze()`
 * returns zero regions with `backendUsed: "unavailable"` rather than
 * throwing out of a perception cycle or fabricating boxes.
 */
export class OnnxFaceVisionModel implements LocalVisionModel {
  private session: import("onnxruntime-web").InferenceSession | null = null;
  private backend: VisionResult["backendUsed"] = "unavailable";
  private readonly modelUrl: string;
  private readonly scoreThreshold: number;
  private readonly iouThreshold: number;

  constructor(options: OnnxFaceVisionModelOptions = {}) {
    this.modelUrl = options.modelUrl ?? resolveDefaultModelUrl();
    this.scoreThreshold = options.scoreThreshold ?? 0.7;
    this.iouThreshold = options.iouThreshold ?? 0.4;
  }

  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
    const ort = await import("onnxruntime-web");
    // Silences benign "initializer appears in graph inputs" warnings from
    // this particular model export (an older PyTorch->ONNX export style) -
    // purely cosmetic, does not affect inference correctness.
    ort.env.logLevel = "error";
    configureOrtWasmPaths(ort);

    for (const ep of ["webgpu", "wasm"] as const) {
      try {
        this.session = await ort.InferenceSession.create(this.modelUrl, {
          executionProviders: [ep],
          graphOptimizationLevel: "all",
        });
        this.backend = ep;
        return;
      } catch {
        // try next execution provider
      }
    }

    // No EP could load the model (missing file, unsupported hardware,
    // etc.) - fail closed rather than throwing, matching FallbackVisionModel's
    // contract so callers don't need to special-case this implementation.
    this.session = null;
    this.backend = "unavailable";
  }

  async analyze(input: VisionInput): Promise<VisionResult> {
    if (!this.initialized) {
      throw new Error("MODEL_INITIALIZATION_FAILED");
    }
    if (this.session === null) {
      return { regions: [], backendUsed: "unavailable", inferenceMs: 0 };
    }

    const started = performance.now();
    try {
      const ort = await import("onnxruntime-web");
      const tensor = preprocessToTensor(ort, input);
      const feeds: Record<string, import("onnxruntime-web").Tensor> = { input: tensor };
      const output = await this.session.run(feeds);
      const regions = postprocess(
        output,
        input.width,
        input.height,
        this.scoreThreshold,
        this.iouThreshold,
        this.backend
      );
      return { regions, backendUsed: this.backend, inferenceMs: performance.now() - started };
    } catch {
      // Fail closed: an inference error must never surface as a thrown
      // exception mid-perception-cycle, and must never be reported as a
      // successful run with fabricated regions.
      return { regions: [], backendUsed: "unavailable", inferenceMs: performance.now() - started };
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.session?.release();
    } catch {
      /* best-effort */
    }
    this.session = null;
    this.backend = "unavailable";
  }
}

function preprocessToTensor(
  ort: typeof import("onnxruntime-web"),
  input: VisionInput
): import("onnxruntime-web").Tensor {
  const rgba = toRgba(input);
  const resized = nearestResizeRgba(rgba, input.width, input.height, INPUT_W, INPUT_H);

  // RFB-320 preprocessing: BGR? Most published exports use RGB, mean=127,
  // std=128, NCHW.
  const data = new Float32Array(3 * INPUT_H * INPUT_W);
  const plane = INPUT_H * INPUT_W;
  for (let i = 0; i < plane; i++) {
    const r = resized[i * 4] ?? 0;
    const g = resized[i * 4 + 1] ?? 0;
    const b = resized[i * 4 + 2] ?? 0;
    data[i] = (r - 127) / 128;
    data[plane + i] = (g - 127) / 128;
    data[2 * plane + i] = (b - 127) / 128;
  }

  return new ort.Tensor("float32", data, [1, 3, INPUT_H, INPUT_W]);
}

function toRgba(input: VisionInput): Uint8ClampedArray {
  if (input.imageData instanceof ArrayBuffer) {
    return new Uint8ClampedArray(input.imageData);
  }
  return input.imageData.data;
}

function nearestResizeRgba(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const srcIdx = (sy * srcW + sx) * 4;
      const dstIdx = (y * dstW + x) * 4;
      dst[dstIdx] = src[srcIdx] ?? 0;
      dst[dstIdx + 1] = src[srcIdx + 1] ?? 0;
      dst[dstIdx + 2] = src[srcIdx + 2] ?? 0;
      dst[dstIdx + 3] = src[srcIdx + 3] ?? 0;
    }
  }
  return dst;
}

function postprocess(
  output: Record<string, import("onnxruntime-web").Tensor>,
  origW: number,
  origH: number,
  scoreThreshold: number,
  iouThreshold: number,
  backend: VisionResult["backendUsed"]
): VisualRegion[] {
  const scoresTensor = output.scores ?? Object.values(output)[0];
  const boxesTensor = output.boxes ?? Object.values(output)[1];
  if (!scoresTensor || !boxesTensor) return [];

  const scores = scoresTensor.data as Float32Array;
  const boxes = boxesTensor.data as Float32Array;
  const numBoxes = boxes.length / 4;

  type Candidate = { score: number; x: number; y: number; width: number; height: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < numBoxes; i++) {
    // scores tensor is [1, N, 2] = [background, face]
    const faceScore = scores[i * 2 + 1] ?? 0;
    if (faceScore < scoreThreshold) continue;

    const xmin = boxes[i * 4] ?? 0;
    const ymin = boxes[i * 4 + 1] ?? 0;
    const xmax = boxes[i * 4 + 2] ?? 0;
    const ymax = boxes[i * 4 + 3] ?? 0;

    candidates.push({
      score: faceScore,
      x: xmin * origW,
      y: ymin * origH,
      width: Math.max(0, (xmax - xmin) * origW),
      height: Math.max(0, (ymax - ymin) * origH),
    });
  }

  const kept = nms(candidates, iouThreshold);

  return kept.map((c, idx) => ({
    id: `face_${idx}`,
    kind: "face" as const,
    bbox: { x: c.x, y: c.y, width: c.width, height: c.height },
    confidence: c.score,
    backend,
  }));
}

function nms<T extends { x: number; y: number; width: number; height: number; score: number }>(
  candidates: T[],
  iouThreshold: number
): T[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: T[] = [];

  while (sorted.length > 0) {
    const current = sorted.shift()!;
    kept.push(current);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (boxIou(current, sorted[i]!) > iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }

  return kept;
}

function boxIou(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Picks the real ONNX backend when a browser-like environment is present,
 * otherwise the honest fallback - mirrors `createOcrService()`'s pattern
 * so Node-based unit tests stay fast/deterministic.
 */
export function createLocalVisionModel(options?: OnnxFaceVisionModelOptions): LocalVisionModel {
  const hasBrowserRuntime = typeof globalThis.document !== "undefined";
  return hasBrowserRuntime ? new OnnxFaceVisionModel(options) : new FallbackVisionModel();
}
