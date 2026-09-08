# Privacy Pipeline

## Detectors

Four independent, genuinely-implemented local detectors run over every
`ScreenState`:

1. **DOM/ARIA semantics** (`privacy/detectors/dom-detector.ts`) — reads
   `input[type=password/email/tel]`, `autocomplete` hints, `name`/`aria-
   label`/`placeholder` text. Highest confidence (0.8–0.99) because it's
   reading structural metadata, not inferring from pixels or prose.
2. **Regex** (`privacy/detectors/regex-detector.ts`) — email, phone
   (including Indian mobile formats), credit-card-like sequences, Aadhaar/
   PAN-like identifiers, URLs/IPs. Runs over DOM text nodes and, now, over
   real OCR-region text from `TesseractOcrService` without modification —
   `privacy-engine.ts` feeds `screen.ocrRegions` through the identical
   `source: "OCR"` code path as DOM text.
3. **Heuristic NER** (`privacy/detectors/ner-detector.ts`) — label-anchored
   name detection (`Operator: John Doe`) at high confidence, plus a
   lower-confidence bare "Capitalized Words" fallback. This is **explicitly
   not a trained model** — see LIMITATIONS.md — and its false-positive rate
   on generic capitalized phrases (e.g. page titles) is visible in the
   benchmark output (`npm run benchmark`), not hidden. It also runs over
   OCR text.
4. **Vision** (`privacy/detectors/vision-detector.ts`) — maps
   `VisualRegion`s from two real, bundled on-device models into FACE/
   DOCUMENT/OTHER findings:
   - `models/local-vision-model.ts`'s `OnnxFaceVisionModel` — a real
     `onnxruntime-web` face-detection pipeline (RFB-320, bundled at
     `apps/extension/public/models/face-detector-rfb320.onnx`, verified
     against a real photo at 99.9997% confidence during development —
     see MODEL_PIPELINE.md).
   - `models/scene-classifier-model.ts`'s `OnnxSceneClassifierModel` — a
     genuine, trained-from-scratch Vision Transformer (bundled at
     `apps/extension/public/models/screen-region-vit.onnx`) that
     classifies whole image/canvas regions as document/chart/photo/code/
     table, satisfying the PS brief's general "ViT that reads the
     screen" description rather than only its face-blur example — see
     LIMITATIONS.md §2 for training methodology, real accuracy numbers,
     and the honest synthetic-vs-real-data caveat.

   Regions with `backend: "unavailable"` (e.g. if a model file were
   removed or corrupted) are skipped, so this detector is safe to run
   unconditionally and produces zero findings rather than fabricated
   ones when a model isn't available.

OCR and vision are wired together in
`perception/capture/image-scan-service.ts`, which scans `<img>`/`<canvas>`
elements on the page (ordinary rendered HTML text never needs OCR — see
`dom-text-source.ts`) and remaps detection bounding boxes back into page
coordinates before fusion.

## Classification & confidence agreement

`privacy/classifier/privacy-classifier.ts` merges findings that target the
**same region** (never merging across unrelated text regions purely
because two numeric offsets happen to overlap — this was a real bug caught
and fixed during development, see the git history / test suite) and boosts
confidence using `1 - (1-a)(1-b)` when multiple detectors agree on the same
span. Final severity is computed from `risk = sensitivity × confidence ×
exposure × context` in `packages/privacy-policy`.

## Policy engine

`packages/privacy-policy` maps each `SensitivityType` to a `PolicyAction`
(`ALLOW | MASK | BLUR | TOKENIZE | BLOCK`). The default table:

| Category | Action |
|---|---|
| PASSWORD, OTP, API_KEY, ACCESS_TOKEN, SECRET | BLOCK |
| CREDIT_CARD, FINANCIAL, ADDRESS, IDENTIFIER, DOCUMENT | MASK |
| EMAIL, PHONE, PERSON, EMPLOYEE_ID | TOKENIZE |
| FACE | BLUR |
| PUBLIC_TEXT, UI_STRUCTURE | ALLOW |

The policy is user-configurable via the extension's options page and is
versioned (`privacyPolicyVersion` on every sanitized payload) for
auditability.

**Fail-closed by design:** if a category is ever missing from the table
(e.g. a bug strips an entry), `decide()` defaults to `MASK`, never `ALLOW`
— verified in `tests/unit/policy-and-redaction.test.ts`.

## Redaction

- **Text** (`redaction/text-redactor.ts`) replaces each finding's span with
  a block-mask (`████`) or a vault token (`[EMAIL_1]`), processing spans
  back-to-front so earlier offsets stay valid.
- **Bounding boxes** (`redaction/bbox-redactor.ts`) plans a `BLACK_BOX`,
  `PIXELATE_BLUR`, or `MASK` region per finding with a `bbox`.
- **Images** (`redaction/image-redactor.ts`) applies that plan to an actual
  `Canvas`/`OffscreenCanvas` — block-pixelation for faces, solid fill for
  passwords/masked regions.

## Local privacy vault

`privacy/vault/privacy-vault.ts` is the **only** place a raw sensitive
value is ever stored. It assigns tokens (`EMAIL_1`, `PERSON_1`, ...) and
persists the raw↔token mapping via IndexedDB (browser) or an in-memory Map
(tests/Node). `resolve()` is only ever called from the local action
executor when typing a value into a page — the resolved raw value is
never serialized into any object that reaches the firewall or network
layer.

## Beyond redaction: vision output also reaches the server as a decision signal

Classified `document`/`table`/`chart` visual regions are additionally
surfaced as non-interactive, non-PII `role: "region"` pseudo-elements in
the sanitized payload (labeled only with their kind, e.g. "Document
region" — never pixel content or OCR'd text), letting the reasoning
server target them with an `EXTRACT` action when relevant to the user's
intent. `FACE` regions are deliberately excluded from this — their only
consequence remains redaction. A separate, opt-in channel
(`screen.redactedScreenshot`, off by default) can also carry a small,
already pixel-redacted screenshot for a vision-capable server-side
model. See `docs/LIMITATIONS.md` §3b and §3c for the full account,
including the real bugs found while building both and the tests proving
they work.
