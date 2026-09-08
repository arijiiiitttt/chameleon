# Limitations — read this before claiming this system is "done"

This repository is a working, tested scaffold that faithfully implements
the architecture, trust boundaries, and control flow described in the
ISRO PS 26171 master build prompt. It is **not** a finished production
system. This document exists because the spec explicitly forbids
pretending otherwise (section 83, "DO NOT CHEAT"). Every item below is a
real gap, not a hedge.

## 1. Local OCR is now real, self-hosted, AND independently verified in an actual browser (this one was genuinely broken until this pass)

`apps/extension/src/perception/ocr/ocr-service.ts`'s `TesseractOcrService`
runs the real Tesseract OCR engine on-device via `tesseract.js` (WASM) —
it is wired into `perception/capture/image-scan-service.ts`, which scans
`<img>`/`<canvas>` elements on the page and feeds recognized text into the
same regex/NER detectors used for DOM text.

**This is the one component that was previously asserted as "should
work" without ever actually being run.** It was subsequently run for
real — a genuine, full Chrome 131 browser was launched (headless, via
Puppeteer, using a Chrome binary already present in the build
environment) and the *actual, unmodified* `TesseractOcrService` class
was exercised against a real canvas-rendered image reading "HELLO OCR".
This surfaced and led to fixing **two real bugs** that no amount of
reading the code would have caught:

1. **Wrong image input type.** `recognize()` was passing a raw `ImageData`
   object directly to tesseract.js. tesseract.js's actual accepted input
   types (`ImageLike` in its own type definitions) are `string |
   HTMLImageElement | HTMLCanvasElement | HTMLVideoElement |
   CanvasRenderingContext2D | File | Blob | Buffer | OffscreenCanvas` —
   raw `ImageData` is not among them. Passing it directly caused
   Leptonica (the underlying image-decoding engine) to fail with
   `"Error in findFileFormatStream: truncated file"` / `"Image file
   /input cannot be read!"`. **Fix**: `toTesseractInput()` now draws the
   `ImageData` onto a canvas first and passes the canvas, which IS a
   supported type.
2. **Wrong result-object shape.** The code read `result.data.words`,
   which does not exist in tesseract.js v7's actual result type — real
   word-level data is nested three levels deep as `data.blocks[].
   paragraphs[].lines[].words[]`, and `blocks` is `null` unless the
   caller explicitly passes `{ blocks: true }` as the third argument to
   `recognize()`. Without both of these, every call silently returned
   zero words with no error at all — a fail-closed-shaped bug that
   looked identical to "no text found," and would never have been
   caught without physically running an image through it, because
   `[]` is also the correct output for genuinely text-free input. **Fix**:
   added `flattenWords()` to walk the real nested structure, and pass
   `{ blocks: true }` explicitly.

Both bugs were only discoverable by actually running the code against
real input in a real browser — the type system didn't catch them
(`Awaited<ReturnType<...>>` on a hand-written type approximation just
mirrors whatever shape you wrote down), and the automated test suite,
prior to this pass, only tested the fail-closed path (missing model,
missing network), never a successful recognition. **After both fixes**,
the exact same unmodified `TesseractOcrService` class correctly
extracted `"HELLO"` (95% confidence) and `"OCR"` (95% confidence) with
correct bounding boxes from a real canvas image, in a real Chrome 131
browser, in 691.8ms end to end (including cold worker initialization).

**The CDN dependency was also a real, separately-discovered bug**, not
just a theoretical caveat: tesseract.js's `createWorker()` defaults to
fetching its worker script and WASM runtime from `cdn.jsdelivr.net`.
When actually tested, this failed outright
(`NetworkError: Failed to execute 'importScripts'... failed to load`)
in a network environment that can't reach that CDN. **Fix**: all
required assets (`worker.min.js`, `tesseract-core-simd.wasm[.js]`,
`eng.traineddata.gz`) are now bundled directly in this repository at
`apps/extension/public/tesseract/` (~9.8 MB total, MIT/Apache-licensed —
`worker.min.js`/core from the `tesseract.js`/`tesseract.js-core` npm
packages already in this repo's dependency tree, `eng.traineddata`
from the `naptha/tessdata` GitHub repository), and
`TesseractOcrService` now passes explicit `workerPath`/`corePath`/
`langPath` resolved via `chrome.runtime.getURL()` (same pattern as
`OnnxFaceVisionModel`'s model loading) instead of relying on the
default CDN paths. This is not just a workaround for this
environment's network restrictions — self-hosting these assets is the
*correct* production configuration for a privacy-focused extension
regardless (no dependency on a third-party CDN being reachable or
trustworthy at runtime), so this fix is a genuine improvement, not a
sandbox-specific hack. The full verification transcript (self-hosted
config, real network request logs, real recognition output) is not
committed as a script in this repo (it was a one-off Puppeteer
harness, since removed) — the real, permanent artifact of it is the
bug fixes themselves plus the bundled assets, both now part of the
shipped code.

**What isn't affected:** ordinary rendered HTML text — the large majority
of PII exposure on typical web pages — is still read directly from the
DOM via `perception/ocr/dom-text-source.ts`, with 1.0 confidence, no OCR
required, and this path has no network dependency at all.

`StubImageOcrService` is retained and used by `createOcrService()` in
non-browser environments (e.g. this repo's Node-based unit tests), so
tests stay fast and deterministic rather than spinning up a real
WASM+network-dependent worker per test run.

## 2. A real, trained Vision Transformer now does general screen-content classification

The PS brief's opening description asks for "a local Vision Transformer
(ViT) or equivalent computer vision model that 'reads' the user's
screen" - a broader ask than face detection (which only satisfies the
brief's specific redaction *example*). `apps/extension/src/models/
scene-classifier-model.ts`'s `OnnxSceneClassifierModel` closes that gap
with a genuine, small ViT (patch embedding → [cls]+positional embeddings
→ 1 transformer encoder block with multi-head self-attention → MLP →
classification head, ~15k parameters) that classifies a whole `<img>`/
`<canvas>` region into one of five screen-content types: `document`,
`chart`, `photo`, `code`, `table`.

**Why trained from scratch instead of using a pretrained ViT**: this
environment's network egress cannot reach huggingface.co,
download.pytorch.org, or any other host serving pretrained ImageNet/ViT
checkpoints — confirmed by directly attempting `pip install torch` (pulls
the full CUDA-bundled wheel, several GB, no disk space) and by checking
DNS/HTTP reachability of the usual model hosts. Only PyPI, npm, and
`github.com`/`raw.githubusercontent.com` are reachable. Rather than ship
an untrained (random-weight) model that would satisfy the type signature
while doing nothing, this ViT was implemented directly in numpy and
**genuinely trained with real gradient descent** (`autograd`'s
reverse-mode automatic differentiation, Adam optimizer, 18 epochs) on a
procedurally generated synthetic dataset (`tools/vit-training/
synthetic_data.py`: 700 training images, 150 held-out validation
images, evenly split across the 5 classes).

**This training run is fully reproducible and disclosed**, not run
once and hand-waved:
- `tools/vit-training/synthetic_data.py` — procedural generator for the
  5 classes (thin horizontal strokes for "document", bar/line shapes for
  "chart", smooth Gaussian-blob gradients with no hard edges for "photo",
  a dark monospace-grid pattern for "code", evenly spaced grid lines for
  "table").
- `tools/vit-training/train_vit.py` — the model definition and training
  loop. Final **validation accuracy: 98.7%** on 150 held-out synthetic
  samples never used in training (`tools/vit-training/
  trained_vit_meta.json` records this number alongside the trained
  weights).
- `tools/vit-training/export_onnx.py` — exports the trained numpy weights
  into a real ONNX graph, built node-by-node with `onnx.helper` (Reshape/
  Transpose for patch extraction, MatMul/Add for linear layers,
  ReduceMean/Sub/Div/Sqrt for LayerNorm, Softmax for attention, Tanh-based
  GELU) rather than via an opaque tracer — every op in the graph is an
  explicit, auditable mirror of a specific line in `train_vit.py`'s
  `forward_single()`.
- `tools/vit-training/verify_parity.py` — the numerical proof that the
  exported ONNX graph actually computes the same function as the trained
  numpy model: on 100 **fresh** synthetic samples (a third, independent
  seed, never used in training or validation), the max absolute
  difference between the numpy forward pass's logits and the real
  `onnxruntime`-executed logits was **0.0000239** (floating-point
  rounding noise, not a bug), and the ONNX model's predictions matched
  the numpy model's predictions on all 100 samples, achieving **100%
  accuracy** against ground truth on that fresh set.
- `tests/unit/vision-and-ocr.test.ts` includes a regression test that
  loads the actual bundled `screen-region-vit.onnx` (no mocking),
  constructs a synthetic table-grid pattern matching the training
  distribution, and asserts the real model classifies it as `"table"`
  with confidence above 0.6 — this exercises the real trained model
  inside the automated test suite, not just in a one-off verification
  script.

**The one honest, disclosed limitation this does NOT remove**: the
training data is procedurally generated synthetic imagery (clean
geometric proxies for "looks like a document," "looks like a chart,"
etc.), not real screenshots or web page crops. The model, its training
process, and its ONNX export are all genuinely real and independently
verified — the 98.7%/100% numbers are true and reproducible — but **how
well this generalizes to real-world page content it has never seen is
untested in this environment**, because no labeled real-screen dataset
exists here (see item 10 below, and DATASET.md, for the same honest gap
already documented for other data sources). Treat this as "the pipeline
and the training methodology are proven correct," not as "this will
correctly classify arbitrary real screenshots out of the box" — it may
need fine-tuning on real captured page content before that claim would
be honest.

**How it's wired in**: `perception/capture/image-scan-service.ts` runs
this classifier (alongside OCR and face detection) on every scanned
`<img>`/`<canvas>` element, producing at most one whole-element
`VisualRegion` per element (kind `document`/`table`/`image`, mapped from
the `document`/`table`/`photo` labels — `chart` and `code` are
intentionally not privacy-relevant and produce no region).
`privacy/detectors/vision-detector.ts`'s `KIND_TO_CATEGORY` maps
`document`/`table` → `DOCUMENT` and `image` → `OTHER`, so a genuinely
classified document-like or table-like image region now contributes a
real `PrivacyFinding`, distinct from and complementary to face detection.

## 3. Local computer vision (face detection) is now a real, bundled, verified inference pipeline

`apps/extension/src/models/local-vision-model.ts`'s `OnnxFaceVisionModel`
is a genuine `onnxruntime-web` inference pipeline (WebGPU execution
provider preferred, WASM fallback), including real preprocessing
(resize/normalize to the model's 320×240 input) and postprocessing
(confidence threshold + IoU-based non-max suppression).

**The model weights are now bundled in this repository**, at
`apps/extension/public/models/face-detector-rfb320.onnx` (~1.27 MB,
MIT-licensed, fetched from the upstream Ultra-Light-Fast-Generic-
Face-Detector-1MB repository — https://github.com/Linzaer/
Ultra-Light-Fast-Generic-Face-Detector-1MB). `npm run build:extension`
copies it into the built extension automatically (Vite's `public/`
convention), and both manifests declare it under
`web_accessible_resources` so a content script (which executes with the
*host page's* origin, not the extension's) can actually fetch it via
`chrome.runtime.getURL(...)` / `browser.runtime.getURL(...)` —
`OnnxFaceVisionModel` resolves this automatically now instead of using a
bare relative path that would previously have 404'd against whatever
page happened to be open.

**Verified with real inference, not just "should work":** during
development, this exact model + the exact preprocessing/postprocessing
code in this file was run end-to-end in Node against a real face photo
(OpenCV's standard `lena.jpg` test image) using `onnxruntime-web`'s WASM
backend outside the test suite — it correctly detected the face at
99.9997% confidence with a bounding box in the expected location. This
confirms the input tensor layout, normalization constants, output tensor
names (`scores`/`boxes`), and NMS logic are all correct against the real
model, not just internally consistent. `tests/unit/vision-and-ocr.test.ts`
includes a regression test that loads this exact bundled file (no
mocking) and asserts a real `onnxruntime-web` session initializes with a
real backend (`wasm`, not `unavailable`) — it does not re-run the face
photo through CI (to avoid embedding an image with murky historical
licensing in the repository, unlike the model weights above, which are
clearly MIT-licensed), so it guards the wiring, not per-commit accuracy.

**What's still a real, disclosed gap:**
- This detects **faces only** — it is not a general Vision Transformer
  doing broad screen/scene understanding, which is what the PS brief's
  opening description gestures toward. "Reading the screen" in this
  system is done by the (fast, exact, zero-inference-cost) DOM/ARIA
  extraction path instead; the vision model's job is scoped specifically
  to the redaction use case the brief's "Expected Solution" section
  describes (blurring faces). Document/sensitive-region classification
  beyond faces is mapped in `vision-detector.ts`'s `KIND_TO_CATEGORY`
  table but has no model behind it — only face detection has a real,
  bundled model target.
- **This component WAS subsequently loaded into a real Chrome browser**
  (see item 19) and its WASM fallback path was directly observed
  engaging correctly. Firefox remains untested — see item 6.
- **WebGPU path**: not just "no GPU-capable context" as an earlier draft
  of this bullet said — `navigator.gpu` itself was directly tested and
  found absent from this browser environment entirely, under three
  different flag combinations including software-rendering overrides
  (see item 20 for the full account, including a correction to an
  earlier, less careful check that had claimed otherwise). The
  WebGPU-then-WASM fallback logic itself was exercised for real (item
  19) and works correctly; WebGPU's own success path cannot be observed
  in this environment at all, not merely "wasn't" in this one test run.

`FallbackVisionModel` is retained and used by `createLocalVisionModel()`
in non-browser (Node test) environments, and as what `OnnxFaceVisionModel`
still degrades to if the model file were ever removed or corrupted — the
fail-closed contract from the original stub is unchanged, it's just no
longer the *only* code path.

## 3a. Privacy pipeline now consumes OCR/vision output end to end

`privacy/privacy-engine.ts`'s `runPrivacyPipeline()` now: (1) runs OCR
text from `screen.ocrRegions` through the same regex/NER detectors as DOM
text (previously `ocrRegions` was always hardcoded empty and never
reached the detectors at all); (2) runs `screen.visualRegions` through a
new `detectVisionSensitivity()` detector (`privacy/detectors/
vision-detector.ts`) that maps FACE/DOCUMENT/sensitive-visual-region
kinds into `PrivacyFinding`s, merged into the same confidence-boosting
`classifyFindings()` step as every other detector; and (3) returns a new
`imageRedactionRegions` field (via the pre-existing `planBboxRedaction()`)
so any bbox-carrying finding — vision-derived or DOM-derived — has a
concrete pixel-redaction plan ready for `applyImageRedaction()` before a
screenshot could ever be considered for the firewall. `content-script.ts`
wires `perception/capture/image-scan-service.ts` (new) into
`perceiveCurrentScreen()` so `<img>`/`<canvas>` content is actually
scanned on every perception cycle, not left as an unused empty array.
This closes the specific gap item 1/2 above used to describe: it's no
longer true that "nothing populates the FACE category" — the pipeline is
real and ready, gated only on the model weights artifact from item 2.

## 3b. Vision now informs DECISIONS, not just redaction — the PS's "reads the screen and takes decisions based on that" gap, closed

Previously, the vision layer's output (face detection, scene
classification) fed ONLY the redaction step - it had zero influence on
what action the reasoning server would propose. This was a real,
disclosed gap against the PS brief's literal wording ("a local Vision
Transformer... that reads the user's screen AND takes decisions based on
that"). It is now closed:

- `privacy/privacy-engine.ts`'s `runPrivacyPipeline()` maps classified
  `document`/`table`/`chart` visual regions into `role: "region"`
  pseudo-elements in the sanitized payload's `screen.elements` array -
  targetable, non-interactive, and labeled only with their kind
  ("Document region", "Data table region", "Chart region") - never any
  pixel content, OCR'd text, or bounding-box coordinates. `FACE` regions
  are deliberately excluded from this - their only legitimate
  server-facing consequence remains redaction, never becoming an
  actionable target (a real, tested invariant - see
  `tests/integration/vision-decisions.test.ts`).
- Each region's `sourceElementId` (assigned by
  `perception/capture/image-scan-service.ts`, reusing the same
  `data-chameleon-id` scheme `dom-extractor.ts` already uses for `<img>`
  elements, and assigning a fresh one for `<canvas>` elements, which
  that extractor never covers at all) makes it a REAL, executor-
  resolvable EXTRACT target, not an inert label - the client's
  `action-validator.ts` re-checks it against the live DOM exactly like
  any other target before executing.
- `apps/server/src/providers/mock-provider.ts`'s planner now has a
  second decision branch: if no interactive element scores well enough
  for a CLICK, it checks whether any vision-classified region's label
  matches the intent's own words (same word-overlap scoring used for
  CLICK matching) and proposes `EXTRACT` on it instead of giving up with
  `DONE`. **Proven with 4 passing tests**
  (`tests/integration/vision-decisions.test.ts`): the identical intent
  ("read the document on this page") produces `DONE` with no vision
  signal present and a real `EXTRACT` targeting the correct element ID
  when a document region is present - a genuinely different decision
  caused by the vision layer's output, not a relabeled existing code
  path.
- Found and fixed two real bugs while building this: (1) the element
  registry was being rebuilt BEFORE the image scan tagged new `<canvas>`
  elements with their `data-chameleon-id`, which would have made any
  such region's `sourceElementId` silently unresolvable; (2) an
  `<img>`-sourced classification would have produced a second,
  duplicate-`id` entry alongside that image's already-existing DOM
  element - fixed by folding the classification into the existing
  element's label (`"Scanned form [Document region]"`) instead.

**What this does NOT do**: a real LLM/VLM still ultimately decides what
to do with this signal (the mock provider's word-overlap heuristic is a
stand-in, same as everywhere else it's used in this codebase - see item
9's PACC/APE mapping table). And this only surfaces WHAT KIND of visual
content exists, never its actual content - a document region says
"there is a document-shaped image here," nothing about what's written on
it (that's OCR's job, already wired separately into the text-detector
path).

## 3c. A real VLM (image) channel now exists — opt-in, off by default

The PS brief explicitly allows either an LLM or a VLM server-side. This
system previously had no image channel at all - only structured,
text-based `SanitizedElement[]` ever left the device. A real, working
VLM channel now exists, disabled by default so nothing about the
existing text-only behavior changes unless explicitly turned on:

- **Client** (`content-script.ts`): when `VITE_VLM_ENABLED=true`, each
  perception cycle requests a screenshot of the current tab from the
  background script (`chrome.tabs.captureVisibleTab` - only callable
  from a background/service-worker context, hence the message hop in
  `background/service-worker.ts`'s new `CAPTURE_VISIBLE_TAB` handler).
  The RAW capture is never used directly: it is drawn to a canvas, and
  the privacy pipeline's own `imageRedactionRegions` (the same bbox
  redaction plan already computed for face/document findings) is applied
  via the pre-existing `applyImageRedaction()` - with each region's bbox
  correctly rescaled from CSS-pixel/viewport coordinates into the
  capture's own pixel coordinates first, since a hi-DPI capture's pixel
  dimensions differ from `window.innerWidth/innerHeight`. Only after
  redaction is it downscaled to a small thumbnail (max 480px wide,
  JPEG q=0.7) and attached to the sanitized payload as
  `screen.redactedScreenshot`.
- **A deliberate, pre-existing security control almost blocked this, on
  purpose - and was extended correctly rather than bypassed.** The
  outbound firewall (`firewall/leakage-detector.ts`) has always blocked
  any field whose name contains "screenshot" - its own docstring said
  such fields "must be explicitly allow-listed by policy config," a
  promise that had never actually been implemented. That allowlist now
  exists: an EXACT key-name match on `redactedScreenshot` (not a fuzzy
  substring match - a maliciously-named lookalike key is still caught,
  proven by a real test in `tests/security/leakage.test.ts`), permitted
  only because the sole writer of that field in this codebase is
  required to call `applyImageRedaction()` first.
- **A real false-positive bug was found and fixed while building this**:
  a large base64 image string, by pure chance of its character
  distribution, will very likely contain coincidental 10-19 digit runs
  that the PHONE/CREDIT_CARD/IDENTIFIER regex patterns would otherwise
  flag on every single screenshot-bearing request - on BOTH the client
  firewall (`firewall/payload-scanner.ts`) and the server's independent
  sanity re-scan (`apps/server/src/shared/protocol.ts`'s
  `serverSideSanityScan()`). Both now exempt only the `redactedScreenshot`
  subtree from pattern scanning, proven with real tests using actual
  long random base64 strings, not short/trivial ones that wouldn't have
  caught the bug.
- **Server** (`apps/server/src/providers/openai-compatible.ts`): when
  `AI_VISION_ENABLED=true` (server-side opt-in, independent of the
  client-side flag - both must be on for an image to actually reach the
  model) and the request carries a screenshot, it's included as a real
  OpenAI-format `image_url` content block, with the raw base64 NOT also
  duplicated inside the text/JSON block (only its width/height metadata
  is). When either flag is off or no screenshot is present, the request
  is byte-for-byte the same text-only shape as before this feature
  existed - proven by 3 real tests
  (`tests/unit/openai-provider-vision.test.ts`) that inspect the actual
  outgoing request body under all three conditions.

**What this does NOT do**: the mock provider (used for the offline demo)
does not use the image at all - only the real `openai-compatible`
provider does, and only against an actual vision-capable model. The
screenshot is a small, layout-context-only thumbnail, not a
high-resolution capture - fine text is still the text-detector/OCR
channel's job, not this one's. And like every other live-browser claim
in this document, this channel's client-side pieces (capture,
redaction, message-passing) have NOT been independently re-verified in
an actual browser session after being built - they are typechecked and
unit-tested, but the specific combination of "real captureVisibleTab
call + real redaction + real network transmission in one live browser
run" was not re-run following this addition (see item 19's own honesty
framing for what "verified in a browser" does and doesn't mean in this
document).

## 4. Heuristic NER, not a trained model

`privacy/detectors/ner-detector.ts` uses label-anchoring
(`Operator: <Name>`) plus a bare "two capitalized words" fallback. It is
explicitly documented as not a trained model in its own file header. The
benchmark (`docs/EVALUATION.md`) shows this honestly: PERSON precision is
0.20 on the synthetic set because the bare-name fallback flags things like
page titles. A real transformer NER model can be substituted behind the
same `NerDetector` interface.

## 5. Address detector — now real, with real (imperfect) heuristic precision

The regex detector now has three real ADDRESS patterns: a US-style
street-address line (house number + capitalized words + a street-type
suffix like "Street"/"Avenue"/"Road", including letter-suffixed house
numbers like "221B"), US ZIP+4 and "STATE ZIP" suffixes, and a
label-anchored Indian PIN code (`Pincode: 560001`, not a bare 6-digit
number, which would be too ambiguous with other identifiers on its own).
`docs/EVALUATION.md`'s benchmark run now shows `ADDRESS: TP=1 FP=0 FN=0,
P=1.00 R=1.00, F1=1.00` on its one synthetic ADDRESS ground-truth case
("221B Baker Street") — a real, measured improvement over the previous
zero recall, not a claim without a number behind it.

**This is still a heuristic pattern set, not a trained/comprehensive
address parser** — the same honest caveat that applies to the rest of
this regex detector (see the module's own header comment: "intentionally
simple/explainable... not a production-grade PII library"). It will miss
address formats it has no pattern for (apartment/unit numbers, PO boxes,
non-US/non-Indian formats, addresses without a recognizable street-type
suffix word) and, like the street-suffix pattern in particular, could
false-positive on a numbered list item that happens to end in a
capitalized word matching one of the suffix tokens (e.g. a business
named "... Trading Co" adjacent to a number is very unlikely to trigger
this specific pattern set, but it isn't provably impossible). The
benchmark's one ADDRESS ground-truth case is not a comprehensive
address-format test suite — see LIMITATIONS.md §11/DATASET.md for the
broader honest gap of "no real labeled PII dataset exists in this
repository" that still applies here too.

## 6. Extension shell — now actually loaded and run in a real Chrome browser (Firefox still untested)

`manifest.chrome.json`/`manifest.firefox.json`, the background service
worker, content script, and popup/options UI are written against the
documented Chrome MV3 / WebExtension APIs and follow the architecture in
this repo's tested `packages/*` and `apps/extension/src/{privacy,firewall,
agent,executor}` modules.

**Chrome: genuinely verified, not just written to spec.** During this
project's development, a real Chrome 131 browser (found to be already
present in this build environment, contrary to an earlier assumption
that no GUI browser was available at all) was launched headless via
Puppeteer, the actual built extension was loaded with `--load-extension`,
and its service worker was confirmed registered at a real
`chrome-extension://<id>/background.js` URL. The real, unmodified
`extractDomElements()` + `detectDomSensitivity()` code was run against a
real page and correctly found a password field and email value. See
LIMITATIONS.md §19 for the complete, precise account of what this did
and did not cover — notably, the full popup-click-to-executed-action
message-passing flow inside one live browser session was attempted but
not completed (a `chrome.tabs.sendMessage` call issued via Puppeteer's
CDP-attached service-worker context did not resolve within a reasonable
timeout, for reasons not fully diagnosed), so that specific integration
path remains unconfirmed end-to-end in a live browser even though its
individual pieces (perception, sanitization, the server) were each
independently verified working.

**Firefox: still genuinely untested.** Written to the WebExtension spec,
consistent with the architecture used for Chrome, but not loaded into an
actual Firefox instance in this pass either. Treat it as "should work,
unverified" rather than "verified."

## 7. Screen fusion's spatial relations are geometric heuristics

`packages/screen-state/src/fusion.ts` computes ABOVE/BELOW/LEFT_OF/
RIGHT_OF/INSIDE/NEAR from bounding-box centers and containment — a simple,
explainable O(n²) pass, not a learned spatial-relationship model. It is
capped at 200 elements per screen to avoid pathological performance on
huge pages.

## 8. Benchmark matching is category-level, not exact-span

Because `PrivacyFinding` deliberately never carries raw text (that
invariant is what keeps the detectors themselves side-channel-safe),
`benchmark/run-benchmark.ts` matches predictions to ground truth by
category count per page rather than by exact text/offset identity. The
IoU-based redaction metrics (`packages/evaluation/src/redaction-metrics.ts`)
*do* support exact bounding-box matching and are ready for use once a real
vision model produces real bounding boxes to evaluate.

## 9. Terminology from later build briefs maps onto existing modules — nothing new was built under these names

Later revisions of the build brief introduced additional named
components: a "Privacy-Aware Context Compiler (PACC)", an "Adaptive
Privacy Engine (APE)", "Dual-Channel Context Representation", a "Privacy
Budget / Risk Controller", and a "Zero-Trust Action Guardian." None of
these were implemented as new, separately-named modules — building a
second parallel architecture under new names, on top of the one already
implemented and tested, would not have added real capability, only
renamed existing code. Here is the honest mapping instead:

| Brief's term | What actually exists |
|---|---|
| Privacy-Aware Context Compiler (PACC) | `privacy/privacy-engine.ts`'s `runPrivacyPipeline()` — takes raw `ScreenState` + detector output and compiles it into the sanitized `SanitizedRequest`, preserving element roles/labels/layout while replacing sensitive values with tokens |
| Adaptive Privacy Engine (APE) | `packages/privacy-policy`'s `PrivacyPolicyEngine` + `computeRisk()`/`severityFromRisk()` — the policy-driven, category-and-confidence-dependent transformation the brief describes |
| Dual-Channel Context (visual + semantic) | **Implemented, opt-in.** `screen.redactedScreenshot` (see LIMITATIONS.md §2b below) carries a small, already pixel-redacted screenshot alongside the semantic `SanitizedElement[]` channel - real image, real transmission, real server-side use when `AI_VISION_ENABLED=true`. Off by default; the semantic channel alone remains fully functional either way |
| Privacy Budget / Risk Controller | `computeRisk()` in `packages/privacy-policy` (sensitivity × confidence × exposure × context), feeding `severityFromRisk()`. It does not currently implement a numeric 0–100 budget score or a dedicated block-vs-degrade decision beyond the existing ALLOW/MASK/BLUR/TOKENIZE/BLOCK actions, but the same inputs and fail-closed philosophy are present |
| Zero-Trust Action Guardian | `executor/action-validator.ts`'s `validateAction()` — already re-checks every server-proposed action against the live screen regardless of the server's own confidence claim, which is the same zero-trust property under a different name |
| CHAMELEON-PrivacyBench | `benchmark/synthetic-pages.ts` + `datasets/adapters/synthetic-privacy-adapter.ts` — the synthetic dataset layer, not under this specific name |

## 10. `DatasetAdapter` interface has only `load()`, not the full method set later briefs describe

A later build brief describes a richer adapter interface —
`load()/validate()/normalize()/getTask()/getScreenshot()/getAnnotations()/evaluate()`.
`datasets/adapters/benchmark-sample.ts`'s `DatasetAdapter` only defines
`load()`, which returns already-normalized `BenchmarkSample[]` — so
`normalize()` happens inside `load()` rather than as a separate exposed
step, and there is no adapter-level `validate()`/`evaluate()` method (validation
and evaluation instead live in `packages/evaluation`, applied uniformly to
whatever `BenchmarkSample[]` any adapter returns). Functionally this
covers the same need — the evaluation engine is still adapter-agnostic —
but it does not literally match the later brief's exact method signatures.

## 11. Dataset strategy — one real layer, three honest stubs

`datasets/adapters/synthetic-privacy-adapter.ts` genuinely wraps the
synthetic benchmark pages into the shared `BenchmarkSample` schema and is
exercised by `tests/unit/dataset-adapters.test.ts`. The open-source
dataset layers (ScreenSpot/ScreenSpot-Pro, Mind2Web, VisualWebArena,
Online-Mind2Web) are represented as concrete `DatasetAdapter`
implementations whose `load()` method truthfully throws
`NOT_IMPLEMENTED` — see `docs/DATASET.md` for exactly what integrating
each would require and why it wasn't done here (no network access to the
dataset mirrors in this environment, and each requires its own license
check and parser). No benchmark number anywhere in this repository is
attributed to any of these three datasets.

## 12. Ablation studies, ROI-based inference, and adaptive resource profiles are not implemented

The build brief calls for systematic ablation experiments (DOM-only vs.
screenshot-only vs. full multimodal, privacy-on vs. privacy-off, etc.),
region-of-interest-limited vision inference, and a LOW/BALANCED/HIGH
resource-adaptation profile selector. None of these exist in this build.
The evaluation harness that does exist (`packages/evaluation`,
`benchmark/run-benchmark.ts`) computes real precision/recall/F1/IoU on the
synthetic dataset, but does not run comparative ablation sweeps.

## 13. No PostgreSQL persistence layer, no separate evaluation dashboard app

The server is stateless beyond request-scoped reasoning (which matches the
brief's own stateless-server preference); no database is wired up because
no feature in this build actually requires persisting benchmark history
across runs. Similarly, there is no standalone `apps/evaluation-dashboard`
— the judge dashboard lives inside the extension popup
(`apps/extension/src/popup/JudgeDashboard.tsx`).

## 14. Action targeting is by stable element ID, not by (semanticRole, accessibleName) tuple

The Action DSL's `targetId` resolves through a `data-chameleon-id`
attribute assigned during DOM extraction, not through a
`{ semanticRole, accessibleName }` descriptor as shown in some later
build-brief examples. In practice this is a more precise targeting
mechanism (it can't collide the way "the second button labeled Submit"
could), but it means the wire format doesn't literally match every
example JSON shown in the brief. `validateActionStructurally` still
independently re-checks role/label/visibility/interactivity against the
live element before execution, so the safety property (client never
trusts the server's target claim) holds regardless of the exact targeting
scheme.

## 15. Post-action verification and client-first local recovery are designed but not wired into a running loop

`docs/AGENT_PROTOCOL.md` describes the intended OBSERVE→VERIFY→RECOVER
cycle, and the agent state machine has the states for it, but the actual
`agent-loop.ts` implementation in this build re-observes after every
action and stops on the first execution failure — it does not yet attempt
local re-planning with an updated DOM/OCR/vision snapshot before falling
back to the server. This is a real gap between the documented design and
the running code, disclosed here rather than papered over.

## 16. Bugs found by a full build/typecheck/runtime audit (not just `npm test`)

`vitest` only *transpiles* TypeScript (strips types via esbuild) — it
never runs `tsc` and therefore cannot catch type errors. A later,
dedicated senior-engineer pass ran `tsc --noEmit` across the entire repo,
actually executed `vite build` for the extension, and actually ran the
compiled server with Node's TypeScript support explicitly disabled
(`--no-experimental-strip-types`, simulating a normal Node install). This
surfaced real defects that 57 passing tests had not caught, because no
test exercised the build/packaging path at all:

1. **Missing `@types/jsdom`.** `tsc --noEmit` failed repo-wide until this
   was installed. `vitest` never noticed because it doesn't type-check.

2. **The extension could not have loaded in a real browser.**
   `manifest.chrome.json`/`manifest.firefox.json` pointed the background
   service worker and content script at raw `.ts` source paths
   (`src/background/service-worker.ts`, `src/content/content-script.ts`).
   The actual Vite build output puts compiled `background.js` and
   `content.js` at the dist root — those source paths don't exist there
   at all. This is the most serious bug found in the whole project: it
   means the extension build produced was never actually loadable, and no
   test would ever have caught it, since no test loads a built extension
   into a browser. Fixed by pointing both manifests at the real build
   artifacts.

3. **Missing icon files.** The manifest referenced `icons/icon128.png`
   (and 16/32/48px variants) that didn't exist anywhere in the repository.
   Chrome refuses to load an unpacked extension with a missing
   manifest-referenced icon. Fixed by generating real PNG icons at all
   four required sizes into `apps/extension/public/icons/`, which Vite
   copies into the build output automatically.

4. **The content script would have thrown a `SyntaxError` on every single
   page load.** The original single-config Vite build bundled
   `background`, `content`, `popup`, and `options` together in one
   invocation. Rollup, given multiple entry points, automatically factors
   shared code (the privacy engine, message-router types, etc.) into a
   separate chunk referenced via `import` statements from each entry.
   Chrome/Firefox always inject `content_scripts` declared in
   `manifest.json` as *classic* (non-module) scripts — a classic script
   containing a top-level `import` throws immediately. This means the
   content script, as originally built, would have failed to execute on
   every page the user visited. Fixed by splitting the build into three
   separate Vite invocations (`vite.config.ts` for popup/options,
   `vite.background.config.ts`, `vite.content.config.ts`), each producing
   the background and content scripts as fully self-contained IIFE
   bundles with zero shared chunks — verified by grepping the built
   output for zero `import` statements and running `node --check` against
   both bundles.

5. **Hardcoded `localhost:8787`** was baked directly into
   `content-script.ts` instead of being configurable, which would have
   silently broken any deployment beyond a local demo. Fixed with a
   build-time `VITE_SERVER_URL` environment variable (see
   `apps/extension/.env.example`), with the missing `vite-env.d.ts` type
   declarations added alongside it.

6. **The compiled server would crash on any standard Node install.**
   Every shared workspace package (`@chameleon/shared-types`,
   `action-dsl`, `privacy-policy`, `screen-state`, `protocol`,
   `evaluation`) had its `package.json` `main`/`types` fields pointing
   directly at raw `.ts` source files. `npm run build:server`'s whole
   purpose is to produce a deployable compiled artifact, but that
   artifact silently only worked in this specific development sandbox
   because its Node 22.22 happens to ship with experimental TypeScript
   type-stripping enabled by default. Running the exact same compiled
   `dist/index.js` with `node --no-experimental-strip-types` (simulating
   an ordinary Node runtime) reproduced a real crash:
   `ERR_UNKNOWN_FILE_EXTENSION` on `packages/protocol/src/index.ts`. Fixed
   by giving every shared package a real `tsc` build step and compiled
   `dist/` output, updating `main`/`types` to point at it, and codifying
   the correct dependency build order in the root `package.json`'s `build`
   script (previously `npm run build --workspaces --if-present`, which
   does not guarantee topological ordering). Re-ran the exact same
   `--no-experimental-strip-types` reproduction after the fix, including a
   full `/api/v1/reason` request through the real Zod schemas and Action
   DSL — it now works correctly on a Node runtime with zero TypeScript
   support.

None of these six defects were caught by the 57-test `vitest` suite,
because none of them touch build output, manifest correctness, or a
standard (non-type-stripping) Node runtime. This is disclosed here as a
methodology note as much as a bug list: a green test suite is not the
same claim as "this actually builds and runs," and both were verified
separately after this point, not just asserted.

## 17. The server intentionally duplicates two small schema files

At the person's request, `apps/server` was restructured to be
independently deployable as a single, standalone folder (no monorepo,
no npm workspaces required). This meant inlining
`apps/server/src/shared/action-dsl.ts` and
`apps/server/src/shared/protocol.ts` as direct copies of
`packages/action-dsl/src/index.ts` and `packages/protocol/src/index.ts`,
rather than importing the workspace packages. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the full rationale, and for the real
tradeoff this introduces: the two copies can drift out of sync if the
Action DSL or protocol schema changes and only one location is updated.
This was verified working — the server folder was copied into full
isolation, installed and built fresh, and run with Node's TypeScript
support disabled — but the duplication itself is a genuine, disclosed
maintenance cost, not a free restructuring.

## 18. What genuinely was verified

Everything **not** listed above was built and then run — not just
written. 57 automated tests exist and pass at the time of writing
(`npm test`), including:

- The literal leakage test, blocking a raw email/password/phone/
  identifier/screenshot field and allowing a properly sanitized payload
- A jsdom-backed DOM extraction test against a real login form and a real
  mission-control-style page
- A full end-to-end pipeline test (DOM → fusion → privacy pipeline →
  firewall) proving raw names/emails/passwords never appear in the
  serialized sanitized payload for either demo scenario
- An in-process HTTP integration test of the Express server, including
  schema rejection and the independent server-side sanity scan
- An agent-loop integration test proving a firewall block halts the loop
  *before* the server is ever called, and that a fixed screen with
  always-executable actions correctly hits the hard iteration cap instead
  of looping forever
- **A full end-to-end test against the actual `demo-site/mission-control.html`
  file** (not a synthetic in-test HTML string) exercising the exact CHAMELEON
  demo command, `"Analyze satellite anomaly; acknowledge incident."`

Four real bugs were found and fixed during this project's development —
all disclosed here rather than hidden, because the tests are doing real
work, not passing by construction:

1. A missing state transition in the agent state machine (`OBSERVING ->
   CLASSIFYING_PRIVACY` skipped the required `PERCEIVING` step).
2. A cross-region finding-merge bug in the classifier that could smuggle
   one element's PII redaction metadata onto a different, unrelated
   element whose local text-offset happened to overlap numerically.
3. **A regex escaping bug in the API_KEY pattern** (`sk-demo-abcdef...`
   wasn't matched because the character class didn't include hyphens
   after the prefix) — caught immediately by
   `tests/unit/chameleon-taxonomy.test.ts`.
4. **A hidden-content leakage bug**, found by the full-demo end-to-end
   test against the real `mission-control.html` file: a `display:none`
   prompt-injection payload on the page was being serialized into the
   "sanitized" payload in full, because the privacy engine only redacted
   *matched PII spans* inside text and had no notion of visibility at all.
   Fixed by excluding non-visible elements from the outbound
   representation entirely (`privacy-engine.ts`), on the reasoning that
   content never rendered for the user has no legitimate reason to leave
   the device — this also happens to be the correct defense against a
   page trying to smuggle prompt-injection text to the reasoning layer via
   an invisible element, though CHAMELEON's primary defense against
   injection remains architectural (the reasoning provider's Action DSL
   has no path from "text in a screen field" to "executed instruction" -
   see `docs/SECURITY.md`), not this filter alone.

This class of bug is exactly why `docs/EVALUATION.md`'s benchmark numbers
are left showing real weaknesses (e.g. the bare-name NER heuristic's low
precision on page titles) rather than being hand-tuned to look clean.

## 19. A real browser was actually used to verify this system — here's exactly what that did and didn't cover

Previous passes over this codebase repeatedly noted "no GUI browser is
available in this environment" as a reason several claims couldn't be
independently verified. That constraint turned out to be **only partly
true**: this sandbox has a real, complete Chrome 131 binary already
present in its Puppeteer cache (`~/.cache/puppeteer/chrome/`), fully
capable of launching headless, loading a real unpacked extension, and
running real WASM/canvas/DOM code. This was discovered and used in this
pass. Being precise about what that did and didn't close matters more
than the fact that a browser was found at all:

**Actually run in a real Chrome browser and directly observed:**
- Loading the actual built extension (`dist-chrome/`) via
  `--load-extension` — its service worker registered at a real
  `chrome-extension://<id>/background.js` URL, confirmed via Puppeteer's
  target list.
- **The full production message-passing flow, completed end to end**:
  popup-equivalent trigger (`chrome.tabs.sendMessage({type:
  "START_TASK", ...})`, issued from a real CDP session attached to the
  actual service worker target) → content script's real `START_TASK`
  handler → the real agent loop → real `extractDomElements()` +
  `detectDomSensitivity()` + sanitization → a real `fetch()` HTTP round
  trip to the real standalone reasoning server (also running for real,
  per `docs/DEPLOYMENT.md`) → the real mock provider's word-overlap
  matching logic correctly selecting `ACKNOWLEDGE INCIDENT` → a real
  `window.confirm()` dialog requesting user approval before executing
  the resulting `CLICK` action. This was the one integration path
  explicitly listed as unconfirmed in an earlier pass over this
  document; it is no longer unconfirmed. **What actually blocked it
  before was a Puppeteer tooling limitation, not an extension bug**:
  Puppeteer's high-level `WorkerTarget.worker().evaluate()` API hung
  indefinitely for this MV3 service worker target (reproduced
  deterministically, including for a trivial no-op `chrome.tabs.query()`
  call with no extension logic involved at all); switching to a raw CDP
  session (`target.createCDPSession()` + `Runtime.enable` +
  `Runtime.evaluate`) against the exact same target resolved
  immediately. This is disclosed precisely because "the flow hangs" and
  "the tool I used to drive the flow hangs" are different claims, and
  conflating them would have been a real dishonesty risk.
- `extractDomElements()` + `detectDomSensitivity()` — the real,
  unmodified code — run against a real page with a password field and an
  email value, correctly producing PASSWORD (0.99 confidence) and EMAIL
  (0.99 confidence) findings.
- `OnnxFaceVisionModel` — a real attempt at the WebGPU execution
  provider (`InferenceSession.create` with `executionProviders:
  ["webgpu"]`) genuinely failed — real console output: `"Failed to
  create WebGPU Context Provider"` — correctly falling back to WASM
  (init 2857ms, inference 107ms on a neutral test frame). This is the
  first time the WebGPU-then-WASM fallback logic was observed actually
  engaging, rather than just being present in the code. **Correction to
  an earlier draft of this document**: this section previously stated
  `navigator.gpu` was present ("exists") in this browser at the time of
  that test. A later, more careful and repeated check (item 20 below)
  found `navigator.gpu` consistently `undefined` under the exact same
  default launch flags, tested three separate times. Rather than quietly
  edit the earlier claim away, it's flagged here: the two observations
  disagree, the more recent one was verified more rigorously (three
  repeated tests, including the literal original flag set), and this
  document now defers to that result — `navigator.gpu` should be treated
  as absent in this environment, and the `onnxruntime-web` failure
  observed here was very likely an EP-creation failure occurring because
  the API surface itself isn't there, not a real adapter negotiation
  that ran and failed. The practical conclusion (WASM fallback engages
  correctly) is unchanged either way.
- `OnnxSceneClassifierModel` — real init (78ms) and inference (4ms),
  correctly classified a synthetic table-grid pattern as `"table"` at
  84.7% confidence.
- `TesseractOcrService` — see item 1 above: two real bugs found and
  fixed by actually running this against real input in a real browser.
- Real browser telemetry: `performance.memory` (7.6 MB used / 12.7 MB
  total JS heap for the full test harness with all three models loaded),
  `navigator.hardwareConcurrency` (1, reflecting this container's actual
  CPU allocation).

**A second real, previously-undetected bug found and fixed via this
verification**: when the actual bundled `content.js` (built by Vite as a
single dependency-free IIFE, per the mandatory content-script build
constraint) ran `OnnxFaceVisionModel`/`OnnxSceneClassifierModel` for
real in the browser, `onnxruntime-web`'s WASM binary failed to load —
real console output: `"failed to asynchronously prepare wasm: both async
and sync fetching of the wasm failed"`, `"Aborted(both async and sync
fetching of the wasm failed)"`. Root cause: onnxruntime-web's default
WASM path resolution relies on `import.meta.url`-relative lookup, which
has nothing meaningful to resolve against inside a single-file IIFE
bundle with no ES module semantics. **Fix**: the four WASM/loader files
onnxruntime-web actually needs (`ort-wasm-simd-threaded.wasm[.mjs]`,
`ort-wasm-simd-threaded.jsep.wasm[.mjs]`) are now bundled at stable,
non-hashed filenames under `apps/extension/public/ort/`, and both
`OnnxFaceVisionModel.initialize()` and
`OnnxSceneClassifierModel.initialize()` explicitly set
`ort.env.wasm.wasmPaths` to a `chrome.runtime.getURL("ort/")`-resolved
path before creating a session — the same self-hosting pattern already
used for the model files and for tesseract.js's assets. **Verified
fixed** by re-running the exact same live-browser test: the WASM-load
failure messages are gone, replaced by real ONNX graph-loading output
(the model's own benign "initializer appears in graph inputs" warnings),
confirming the session actually loaded and ran.

**Still NOT covered by this verification, honestly:**
- **Firefox** — not attempted in this pass.
- **WebGPU actually succeeding** (as opposed to correctly failing over to
  WASM) — this container's headless Chrome has no real GPU behind it, so
  the WebGPU code path's *success* case remains unverified; only its
  *failure-handling* was exercised, which is itself useful information
  but is not the same claim.
- **The repeated confirmation-dialog behavior observed during the live
  end-to-end run** (the agent proposed the same `CLICK` action across
  multiple iterations after each dialog was dismissed) was observed but
  not root-caused in this pass. The most likely explanation given the
  code — the agent loop legitimately re-proposing the same
  highest-confidence action on the next iteration after a
  `REQUEST_CONFIRMATION` is declined, since nothing about the page or
  intent changed — is plausible but was not verified by reading the
  agent-loop retry logic line by line in this pass. Flagged here rather
  than either asserted as correct or silently ignored.
- **Resource/latency numbers under realistic load** — since superseded
  by a proper benchmark run (see item 21 below): a disclosed
  warm-up-then-10-iteration methodology against a 387-element realistic
  page, not a single cold run against tiny synthetic inputs. Still not
  the client-resource-utilization/end-to-end-latency benchmark the PS's
  evaluation rubric ultimately calls for, since that needs real end-user
  hardware across a range of devices, not one 1-vCPU sandboxed
  container — see item 21 for the precise, narrower claim this new
  measurement does support.
- **A real face photo in this browser session specifically** — the
  face model's accuracy against a real photo was verified separately in
  Python/onnxruntime (99.9997% confidence on OpenCV's `lena.jpg`, see
  MODEL_PIPELINE.md); this browser session only confirmed the model
  *loads and runs* in Chrome (against a neutral gray frame, correctly
  producing zero detections), not that it detects real faces *inside a
  browser specifically* — that combination (real face photo + real
  browser + real extension) was not tested.

## 20. WebGPU genuinely does not exist in this development environment — tested directly, not assumed

An earlier pass over this repository stated that "WebGPU's success
path... remains unverified" because this container has no GPU. That
statement undersold how directly this was actually tested: `navigator.gpu`
was checked in the real headless Chrome 131 browser used throughout this
document, first under default launch flags, then again with
`--enable-unsafe-webgpu --use-angle=swiftshader --enable-features=Vulkan`
(a combination that can make WebGPU available via pure software
rendering, with no real GPU, on some Chrome builds/environments), and a
third time with `--enable-webgpu-developer-features
--ignore-gpu-blocklist --disable-gpu-sandbox` added. In all three
attempts, `typeof navigator.gpu` was `"undefined"` — not "adapter request
failed" (which `OnnxFaceVisionModel`/`OnnxSceneClassifierModel` already
handle and fall back from correctly, per item 19), but the API surface
itself absent. This confirms WebGPU is unavailable at the browser-build/
environment level in this specific sandbox, not merely lacking a GPU to
request an adapter from - no further flag combination is likely to
change this without a fundamentally different container image. The
WebGPU-then-WASM fallback CODE remains correct and was exercised for
real (item 19); its SUCCESS path (a WebGPU session actually initializing
against a real adapter) has not been observed anywhere in this
document's development history, and cannot be, in this environment.

## 21. A real, methodologically disclosed resource/latency benchmark now exists

`benchmark/results/real-browser-load-benchmark.json` (summarized in
`docs/EVALUATION.md`'s "Client resource / latency metrics" section) is a
real measurement, not a single ad-hoc timing: a real Chrome 131 browser,
a procedurally generated 387-element "realistic" page (nav, 60 status
cards, a login form, a 30×6 table, 4 canvas elements), one untimed
warm-up run followed by 10 timed iterations with mean/median/p95 computed
over those 10 - a genuine methodology upgrade from a prior single cold
run. It isolates the real cost driver by also running the identical page
with its 4 canvases removed (median total per-cycle time: 139.9ms with
canvases present running real OCR+vision inference, vs 13.9ms without),
confirming the cost scales with the number of scanned images, not
overall page/DOM size - the architecturally expected shape, not a
discovered problem.

**What this measurement does NOT claim to be**: a formal answer to the
PS's "client-side resource utilization" (20%) or "end-to-end latency"
(15%) evaluation criteria. Both of those, properly answered, need
numbers from real end-user hardware (varying CPU core counts, actual
GPUs enabling the WebGPU path this container cannot exercise at all per
item 20, real browser cache warm states) across a representative range
of devices - not one 1-vCPU, no-GPU sandboxed container running 10
iterations of one synthetic page. This is a real, reproducible,
disclosed-methodology reference point that is honestly framed as a
floor/worst-case indicator, not a substitute for that broader
measurement exercise.

## 22. A real, externally-authored dataset now validates detection recall — and found a real bug

`benchmark/run-external-benchmark.ts` runs the real regex detector
against `datasets/external/presidio_context_sentences.txt`, a genuine,
MIT-licensed test fixture copied verbatim from Microsoft's own Presidio
project (license copy alongside it) - authored by an unrelated team for
an unrelated (but conceptually adjacent) PII-detection tool, not written
or influenced by this project in any way. This directly addresses the
honest caveat attached to every synthetic-page benchmark number in this
document: a detector validated only against its own author's test data
can look better than it is.

**This surfaced a real, previously undiscovered bug**: the first run
showed **0% recall on US Social Security Numbers** - the regex detector
had no SSN pattern at all, only Aadhaar/PAN-like formats reflecting this
project's Indian/ISRO context. A real fix (two new `IDENTIFIER` patterns:
dashed `XXX-XX-XXXX`, and bare 9-digit) raised this dataset's overall
recall from 0.44 to 0.83, confirmed by re-running the same script, and
confirmed via `npm run benchmark` to have introduced zero new false
positives on the existing synthetic-page benchmark. See
`docs/EVALUATION.md`'s "External-dataset validation" section for the
full per-category numbers.

**What this does NOT do**: this dataset only covers a subset of
CHAMELEON's taxonomy (phone numbers, IP addresses, and several
government-identifier formats) - it says nothing about EMAIL, PASSWORD,
CREDIT_CARD, PERSON, or ADDRESS detection quality, which remain measured
only against this project's own synthetic pages (see
`docs/EVALUATION.md`'s main benchmark section, including the honestly
weak PERSON/PHONE precision numbers there). It also measures RECALL
only - the file contains no negative (PII-free) examples, so it cannot
be used to estimate false-positive rate. Finding one more real,
externally-validated PII dataset with negative examples and broader
category coverage would be a genuine next step, not a solved problem.

## 23. Live confidence percentage in the popup — a real gap found and closed while adding it

The popup's Judge Dashboard displayed counts, status words, and
millisecond timings, but never a confidence percentage - even though
every proposed action has always carried a real `confidence: number`
(0-1) field (see `packages/action-dsl`). While wiring this up, a deeper,
previously undocumented gap was found: **the content script never
actually sent an `AGENT_STATUS` message at all**. The relay
infrastructure (`message-router.ts`'s type, `service-worker.ts`'s
listener, `tab-manager.ts`'s per-tab cache, `JudgeDashboard.tsx`'s
`REQUEST_STATUS`/`AGENT_STATUS` listeners) was all present and correct -
but nothing on the producing end ever populated or sent one. The popup's
live numbers were, until this fix, permanently frozen at their static
initial values for the whole life of any real session.

**The fix**, kept additive and non-invasive to the agent loop's existing
tests:
- `agent-loop.ts` gained an optional `onStatus` callback in
  `AgentLoopDeps`, called after `sanitize()` (confidence still `null` -
  no plan has been received yet, and the popup must render "—", never a
  fabricated placeholder like `0%`) and again after a plan is received
  (the real `candidate.confidence` value). Real `performance.now()`
  deltas for `perceive`/`sanitize`/`server` are measured and passed
  alongside it - not new fabricated numbers, the same real-timing
  discipline already used elsewhere in this codebase.
  `onStatus` being optional means all three pre-existing agent-loop
  tests, none of which provide one, kept passing unmodified - confirmed
  by re-running them.
- `content-script.ts` implements `sendAgentStatus()`, the one place an
  `AgentStatusMessage` is actually constructed, and wires it as
  `onStatus` when building `AgentLoopDeps`. `client.localVision`/`ocr`
  now reflects a genuinely tracked `visionModelsReady` flag rather than
  a hardcoded `"READY"`; `server.api` is inferred as `CONNECTED` once a
  plan has actually been received (an honest deduction from data already
  in hand, not a guess).
- `JudgeDashboard.tsx` renders `lastActionConfidence === null ? "—" :
  ${(confidence * 100).toFixed(0)}%`.

**Verified in a real, live, loaded Chrome extension**, not just unit
tests: a real task was triggered via the same CDP+`chrome.tabs.
sendMessage` approach used throughout item 19, and the real
`AGENT_STATUS` messages flowing through the actual running extension
were captured directly. The first message showed `lastActionConfidence:
null` (would render as "—"); every subsequent message showed the real
mock provider's `0.99` confidence (would render as "99%") - 30 real
messages captured across several agent-loop iterations, all consistent.
A new automated test (`tests/integration/agent-loop.test.ts`) also
locks in the same null-then-real-value behavior so this can't silently
regress.

**What this does NOT do**: it does not add a UI for historical/trend
data (only the single most recent action's confidence is shown, matching
what `AgentStatusMessage` was already designed to carry), and it does
not change the underlying confidence VALUES themselves - those come
from whichever reasoning provider is active (the mock provider's
word-overlap score, or a real LLM/VLM's own reported confidence),
unchanged by this work.
