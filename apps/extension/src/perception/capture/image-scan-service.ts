import type { OCRRegion, VisualRegion } from "@chameleon/shared-types";
import type { OcrService } from "../ocr/ocr-service.js";
import type { LocalVisionModel } from "../../models/local-vision-model.js";
import type { SceneClassifierModel } from "../../models/scene-classifier-model.js";

/**
 * The DOM/ARIA extractor already covers ordinary rendered text with exact,
 * high-confidence results (see dom-text-source.ts). Real OCR/vision only
 * need to run over the minority of elements whose content is NOT visible
 * to the DOM text layer at all: <canvas> (always opaque pixels to the DOM)
 * and <img> (may contain sensitive baked-in text/faces, e.g. a scanned ID
 * card or a screenshot pasted into a form).
 *
 * Skips elements below MIN_DIMENSION_PX - running a WASM OCR/vision pass
 * over every 16x16 icon on a page would be pure overhead for zero privacy
 * benefit.
 */
const MIN_DIMENSION_PX = 48;
/** Hard cap so a pathological page (hundreds of images) can't stall perception. */
const MAX_ELEMENTS_SCANNED = 12;

export interface ImageScanResult {
  ocrRegions: OCRRegion[];
  visualRegions: VisualRegion[];
}

function isEligible(el: Element): el is HTMLImageElement | HTMLCanvasElement {
  if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLCanvasElement)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_DIMENSION_PX || rect.height < MIN_DIMENSION_PX) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function toImageData(el: HTMLImageElement | HTMLCanvasElement): ImageData | null {
  try {
    const width = el instanceof HTMLCanvasElement ? el.width : el.naturalWidth || el.width;
    const height = el instanceof HTMLCanvasElement ? el.height : el.naturalHeight || el.height;
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    // Cross-origin <img> without CORS headers taints the canvas and
    // throws on getImageData - fail closed (skip this element) rather
    // than crash perception for the whole page.
    return null;
  }
}

/**
 * Scans eligible <img>/<canvas> elements on the current document with the
 * real OCR service and local vision model, returning results in the same
 * viewport-relative bbox coordinate system the DOM extractor uses (so they
 * fuse correctly with `ScreenElement.bbox`).
 */
/**
 * Maps a scene classifier label to a VisualRegionKind, for the classes
 * that have privacy relevance (see vision-detector.ts's KIND_TO_CATEGORY).
 * "chart" and "code" are intentionally excluded - they carry no
 * distinguishing privacy signal over generic UI content.
 */
const SCENE_LABEL_TO_KIND: Partial<Record<string, VisualRegion["kind"]>> = {
  document: "document",
  table: "table",
  photo: "image",
};

/**
 * Mirrors dom-extractor.ts's `stableAttrId()` exactly - reuses an
 * existing `data-chameleon-id` if the DOM extractor already assigned one
 * to this element (true for `<img>`, which IS in its CONTENT_SELECTOR),
 * or assigns a fresh one (needed for `<canvas>`, which is NOT in that
 * selector and so is otherwise invisible to the element registry). This
 * is what makes a scene-classified region a real, executor-resolvable
 * EXTRACT target rather than an inert label - see privacy-engine.ts's
 * `visualElements` construction and docs/LIMITATIONS.md's "vision now
 * informs decisions" entry.
 */
let visionIdCounter = 0;
function stableElementId(el: Element): string {
  const existing = el.getAttribute("data-chameleon-id");
  if (existing) return existing;
  visionIdCounter += 1;
  const generated = `visimg_${visionIdCounter}`;
  el.setAttribute("data-chameleon-id", generated);
  return generated;
}

export async function scanImagesAndCanvases(
  doc: Document,
  ocrService: OcrService,
  visionModel: LocalVisionModel,
  sceneClassifier?: SceneClassifierModel
): Promise<ImageScanResult> {
  const candidates = Array.from(doc.querySelectorAll("img, canvas")).filter(isEligible);
  const elements = candidates.slice(0, MAX_ELEMENTS_SCANNED);

  const ocrRegions: OCRRegion[] = [];
  const visualRegions: VisualRegion[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    const sourceElementId = stableElementId(el);
    const imageData = toImageData(el);
    if (!imageData) continue;

    const rect = el.getBoundingClientRect();

    try {
      const words = await ocrService.recognize(imageData, imageData.width, imageData.height);
      const scaleX = rect.width / imageData.width;
      const scaleY = rect.height / imageData.height;
      for (const w of words) {
        ocrRegions.push({
          ...w,
          id: `img${i}_${w.id}`,
          bbox: {
            x: rect.x + w.bbox.x * scaleX,
            y: rect.y + w.bbox.y * scaleY,
            width: w.bbox.width * scaleX,
            height: w.bbox.height * scaleY,
          },
        });
      }
    } catch {
      // OCR is fail-closed at the service level already; this catch is
      // defense-in-depth so one bad element never aborts the whole scan.
    }

    try {
      const result = await visionModel.analyze({
        imageData,
        width: imageData.width,
        height: imageData.height,
      });
      const scaleX = rect.width / imageData.width;
      const scaleY = rect.height / imageData.height;
      for (const region of result.regions) {
        visualRegions.push({
          ...region,
          id: `img${i}_${region.id}`,
          bbox: {
            x: rect.x + region.bbox.x * scaleX,
            y: rect.y + region.bbox.y * scaleY,
            width: region.bbox.width * scaleX,
            height: region.bbox.height * scaleY,
          },
        });
      }
    } catch {
      // Vision model is fail-closed at the model level already; same
      // defense-in-depth rationale as above.
    }

    // Whole-region scene classification (real Vision Transformer - see
    // models/scene-classifier-model.ts) - this is a SINGLE label for the
    // whole element, not a per-box detection like OCR/face above, so it
    // contributes at most one VisualRegion per element, covering the
    // element's full bbox.
    if (sceneClassifier) {
      try {
        const result = await sceneClassifier.classify({
          imageData,
          width: imageData.width,
          height: imageData.height,
        });
        const kind = result.label ? SCENE_LABEL_TO_KIND[result.label] : undefined;
        if (kind && result.backendUsed !== "unavailable") {
          visualRegions.push({
            id: `img${i}_scene`,
            kind,
            bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            confidence: result.confidence,
            backend: result.backendUsed,
            sourceElementId,
          });
        }
      } catch {
        // Scene classifier is fail-closed at the model level already;
        // same defense-in-depth rationale as above.
      }
    }
  }

  return { ocrRegions, visualRegions };
}
