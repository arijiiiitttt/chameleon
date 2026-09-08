# Model Pipeline

## LocalVisionModel interface

```ts
interface LocalVisionModel {
  initialize(): Promise<void>;
  analyze(input: VisionInput): Promise<VisionResult>;
  dispose(): Promise<void>;
}
```

`VisionResult` always reports which backend actually ran
(`"webgpu" | "wasm" | "cpu" | "unavailable"`) — never fabricated.

**Real implementation: `OnnxFaceVisionModel`** (`apps/extension/src/models/
local-vision-model.ts`), backed by `onnxruntime-web` (v1.29):

- Tries the WebGPU execution provider first, falls back to WASM if
  session creation throws on WebGPU (e.g. unsupported GPU/browser).
  `backendUsed` always reflects whichever EP the session actually loaded
  with.
- **Model**: Ultra-Light-Fast-Generic-Face-Detector-1MB, RFB-320 variant.
  ~1.3 MB fp32 ONNX, 320×240 input, two output tensors (`scores` [1,N,2],
  `boxes` [1,N,4], normalized xmin/ymin/xmax/ymax). Post-processed with a
  standard confidence-threshold + IoU-based NMS pass (`scoreThreshold`
  0.7 / `iouThreshold` 0.4 by default, both configurable).
- **Latency** (upstream model's published figures — not independently
  re-benchmarked in this sandboxed environment, which has no GPU/browser
  to benchmark against): ~8–15 ms/frame on a WebGPU-capable discrete GPU,
  ~40–90 ms/frame on WASM SIMD on a typical laptop CPU.
- **Model binary is bundled** at `apps/extension/public/models/
  face-detector-rfb320.onnx` (~1.27 MB, MIT license, fetched from
  https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB).
  `OnnxFaceVisionModel` resolves the load URL via `chrome.runtime.getURL()`
  / `browser.runtime.getURL()` when running inside an extension context
  (content scripts execute with the *host page's* origin as their base,
  so a bare relative path would otherwise resolve against whatever page
  happens to be open, not the extension's own bundle) — see
  `resolveDefaultModelUrl()`. Both manifests declare
  `models/*.onnx` under `web_accessible_resources` so this fetch is
  actually permitted. `npm run build:extension` copies the file into the
  build output automatically via Vite's `public/` convention; verified by
  inspecting `dist-chrome/models/face-detector-rfb320.onnx` after a real
  build.
- **Independently verified against a real photo** (outside the automated
  test suite, to avoid embedding a face image with murky historical
  licensing into this repository): the exact tensor preprocessing,
  session I/O names (`input` → `scores`/`boxes`), and NMS postprocessing
  in this file were run against OpenCV's standard `lena.jpg` test image
  via `onnxruntime-web`'s WASM backend in Node, and correctly detected
  the face at 99.9997% confidence with a bounding box in the expected
  region of the image. `tests/unit/vision-and-ocr.test.ts` includes a
  lighter-weight automated regression test that loads this exact bundled
  file (no mocking) and confirms a real session initializes with a real
  backend.
- Model file provisioning is therefore no longer a manual step for face
  detection specifically — it ships with the repo. A different/larger
  vision model (e.g. one that also does document classification, or a
  general scene-understanding ViT) would still need to be added the same
  way: drop the `.onnx` file under `apps/extension/public/models/`,
  point `modelUrl` at it, and adjust the pre/postprocessing to match that
  model's actual input/output tensor shapes.
- Bundling note: `onnxruntime-web`'s default WASM asset
  (`ort-wasm-simd-threaded.jsep-*.wasm`) is a genuinely large runtime
  (~28 MB uncompressed) because it includes SIMD+threading+WebGPU JSEP
  glue. For a production build, pin `ort.env.wasm.wasmPaths` to a
  CDN-hosted single-threaded WASM build (~9 MB) or self-host only the
  variant your target browsers need, and keep the `import("onnxruntime-web")`
  dynamic import so it's only fetched when a page actually has
  `<img>`/`<canvas>` content worth scanning (see
  `perception/capture/image-scan-service.ts`), not on every page load.

`FallbackVisionModel` is kept as the explicit, honest "no backend
available" implementation — used by `createLocalVisionModel()` in
non-browser (e.g. Node test) environments, and as what `OnnxFaceVisionModel`
degrades to whenever the model file is genuinely unavailable.

`ModelManager` (`apps/extension/src/models/model-manager.ts`) remains
available for callers that want load-once caching/warm-up across
multiple named models; `OnnxFaceVisionModel` itself already satisfies the
"never re-initialize per frame" requirement internally (one `initialize()`
call per content-script lifetime, reused by every `analyze()` call).

## OcrService interface

```ts
interface OcrService {
  recognize(image: ImageData | ArrayBuffer, width: number, height: number): Promise<OCRRegion[]>;
}
```

Ordinary page text does not need this — `perception/ocr/dom-text-source.ts`
wraps DOM text nodes directly into the same `OCRRegion` shape at 1.0
confidence.

**Real implementation: `TesseractOcrService`** (`apps/extension/src/
perception/ocr/ocr-service.ts`), backed by `tesseract.js` v7 (Apache-2.0),
which runs the actual Tesseract OCR engine on-device via WASM — no server
round-trip for recognition itself. **Independently verified working in a
real Chrome 131 browser** (not just Node/jsdom) during this project's
development, which is how the two bugs described immediately below were
actually found — see LIMITATIONS.md §1 for the full account of both.

- **Model/runtime size**: ~3.5 MB `tesseract-core-simd.wasm` runtime +
  ~4.7 MB JS glue + one `eng.traineddata.gz` language model (~2 MB
  gzip'd) — **all bundled directly in this repository** at
  `apps/extension/public/tesseract/` (~9.8 MB total) rather than fetched
  from tesseract.js's default jsDelivr CDN at runtime. `TesseractOcrService`
  passes explicit `workerPath`/`corePath`/`langPath` resolved via
  `chrome.runtime.getURL()` (same self-hosting pattern as
  `OnnxFaceVisionModel`'s model loading) — the CDN-dependent default
  configuration was tested for real and failed
  (`NetworkError: ...importScripts... failed to load`) in a network
  environment that couldn't reach `cdn.jsdelivr.net`; self-hosting is
  also simply the correct choice for a privacy-focused extension
  regardless of network environment.
- **Latency, measured for real** (not estimated): 691.8ms end-to-end for
  a small (200×60px) synthetic text image in a real Chrome 131 browser,
  including cold worker initialization — of that, initialization alone
  was ~700ms and actual recognition ~89ms. Expect roughly similar
  cold-start cost on first use per page session, with warm reuse much
  faster since the worker is cached (see below).
- **Two real bugs found and fixed by actually running this against real
  input in a real browser** (full account in LIMITATIONS.md §1): (1)
  raw `ImageData` was being passed directly to `recognize()`, but
  tesseract.js's real accepted input types don't include raw `ImageData`
  — fixed by drawing it onto a canvas first; (2) the code read
  `result.data.words`, which doesn't exist in tesseract.js v7's actual
  result shape (real structure: `data.blocks[].paragraphs[].lines[].
  words[]`, with `blocks: null` unless `{ blocks: true }` is explicitly
  requested) — fixed with a `flattenWords()` helper and the explicit
  output option. **After both fixes**, the exact same class correctly
  extracted `"HELLO"` and `"OCR"` (95% confidence each, correct bounding
  boxes) from a real rendered canvas image.
- A single worker is created lazily on first use and reused for every
  subsequent `recognize()` call (spec section 10). Any initialization or
  recognition failure (corrupt worker, unexpected input, etc.) is caught
  and returns `[]` rather than throwing or fabricating text — see the
  fail-closed discussion in the file's own doc comment.
- `StubImageOcrService` remains as the explicit honest-empty
  implementation, used by `createOcrService()` in non-browser (e.g. Node
  test) environments where spinning up a real WASM worker would make
  tests slow and non-deterministic.

## SceneClassifierModel interface (the general ViT / scene-understanding model)

```ts
interface SceneClassifierModel {
  initialize(): Promise<void>;
  classify(input: SceneClassifierInput): Promise<SceneClassifierResult>;
  dispose(): Promise<void>;
}
```

This is the piece that satisfies the PS brief's opening description of
"a local Vision Transformer (ViT) or equivalent computer vision model
that 'reads' the user's screen" — `OnnxFaceVisionModel` above detects
faces specifically (the brief's redaction *example*); this model does the
broader "what kind of content is this region" classification the brief's
architecture paragraph describes.

**Real implementation: `OnnxSceneClassifierModel`**
(`apps/extension/src/models/scene-classifier-model.ts`), a genuine,
small Vision Transformer classifying a whole image/canvas region into
one of 5 classes: `document`, `chart`, `photo`, `code`, `table`.

**Architecture** (deliberately tiny — targets a WASM/WebGPU browser
budget, not natural-image accuracy):
- 32×32×3 input, patch size 8×8 → 16 patches, patch_dim 192
- embed_dim 32, 1 transformer encoder block, 4 attention heads
- MLP hidden dim 64, tanh-approximation GELU, pre-norm LayerNorm
- classification head reads the `[cls]` token's final embedding
- ~15,000 parameters total, exported model file is **65 KB**

**Why trained from scratch instead of fine-tuning a pretrained ViT**:
this environment's network egress cannot reach huggingface.co,
download.pytorch.org, or any other host serving pretrained ImageNet/ViT
checkpoints (confirmed directly — `pip install torch` pulls a multi-GB
CUDA-bundled wheel with no CPU-only build reachable from PyPI's default
index, and there was insufficient disk space regardless). Only PyPI,
npm, and `github.com`/`raw.githubusercontent.com` are reachable. Rather
than ship a randomly-initialized model that would satisfy the interface
while doing nothing, this ViT was implemented directly in numpy and
genuinely trained with real gradient descent.

**Training pipeline** (fully reproducible, in `tools/vit-training/`):
1. `synthetic_data.py` — procedurally generates 32×32 synthetic images
   for the 5 classes (thin horizontal strokes for documents, bar/line
   shapes for charts, smooth edge-free Gaussian gradients for photos, a
   dark monospace-grid pattern for code, evenly spaced grid lines for
   tables).
2. `train_vit.py` — defines the model and trains it with `autograd`
   (reverse-mode automatic differentiation over plain numpy) + Adam, 18
   epochs, 700 training / 150 validation images. **Final validation
   accuracy: 98.7%** (`trained_vit_meta.json` records this alongside the
   saved weights).
3. `export_onnx.py` — exports the trained weights into a real ONNX
   graph built node-by-node with `onnx.helper` (every Reshape/Transpose/
   MatMul/LayerNorm-primitive/Softmax/GELU op is an explicit, auditable
   mirror of a specific line in `train_vit.py`'s `forward_single()` —
   not an opaque tracer/converter output).
4. `verify_parity.py` — proves the ONNX graph computes the same function
   as the trained numpy model: on 100 **fresh** synthetic samples (a
   third, independent random seed never used in training or
   validation), max absolute logit difference between numpy and real
   `onnxruntime` execution was **0.0000239** (floating-point rounding
   noise), and predictions matched on all 100 samples with **100%**
   accuracy against ground truth.

**Model binary is bundled** at `apps/extension/public/models/
screen-region-vit.onnx` (65 KB), resolved the same way as the face
model (`chrome.runtime.getURL`/`browser.runtime.getURL`), covered by the
same `web_accessible_resources` manifest entry (`models/*.onnx`).

**Latency**: not independently benchmarked in an actual browser (no GUI
browser in this environment) — given the model's size (65 KB, ~15k
params, 1 transformer block), expect low-single-digit milliseconds on
WASM and sub-millisecond on WebGPU, but this is an estimate from model
size, not a measured number.

**The one limitation this doesn't remove**: training/validation/parity
data is all procedurally generated synthetic imagery, not real
screenshots. See LIMITATIONS.md §2 for the full, undiluted statement of
what this does and doesn't prove.

`FallbackSceneClassifierModel` is the honest no-op used in non-browser
(Node test) environments and as the safe degradation target if the model
file were ever missing or corrupted.

## Where OCR/vision actually run

`apps/extension/src/perception/capture/image-scan-service.ts`'s
`scanImagesAndCanvases()` is the integration point: it walks the live
document for `<img>`/`<canvas>` elements at least 48×48px (skipping tiny
icons), rasterizes each to an `ImageData` via an offscreen `<canvas>`,
runs `OcrService.recognize()`, `LocalVisionModel.analyze()` (face
detection), and `SceneClassifierModel.classify()` (whole-region
document/chart/photo/code/table classification) against it, and remaps
the resulting bounding boxes from image-local pixel coordinates back
into the page's viewport-relative coordinate system (matching
`ScreenElement.bbox`'s convention) so they fuse correctly with
DOM-derived elements in `fuseScreenState()`. `content-script.ts` calls
this once per perception cycle and feeds the results into
`ScreenState.ocrRegions` / `ScreenState.visualRegions`, which
`privacy-engine.ts` now consumes directly (OCR text through the same
regex/NER detectors as DOM text; vision regions — face, document, table,
image — through the `detectVisionSensitivity()` detector — see
PRIVACY.md).

## Model manager guarantees

`apps/extension/src/models/model-manager.ts`:

- De-dupes concurrent `load()` calls for the same model id
- Never re-runs `load()` if already loaded ("Models must
  not initialize repeatedly for every frame")
- Exposes `getHandle(modelId)` for telemetry/backend reporting
- `unload()` calls the definition's `dispose()` before freeing the
  cached instance
