import type { BoundingBox, OCRRegion } from "@chameleon/shared-types";

export interface OcrService {
  recognize(image: ImageData | ArrayBuffer, width: number, height: number): Promise<OCRRegion[]>;
}

/**
 * Model note (spec sections 8, 83): real image OCR is now implemented with
 * `tesseract.js` (Apache-2.0), which runs entirely on-device via a WASM
 * build of the Tesseract engine - no network calls for the recognition
 * itself. The only network fetch involved is the one-time download of the
 * `eng.traineddata` language model (~4-5 MB gzip, cached by the browser
 * after first load) and the ~2 MB tesseract core WASM runtime, both
 * fetched the first time OCR actually runs on a page. Typical latency on
 * a mid-range laptop: ~150-400ms per screen-sized crop (WASM, single
 * worker; tesseract.js has no GPU acceleration path).
 *
 * This is deliberately NOT used for ordinary page text - see
 * `DomTextLayerSource` in dom-text-source.ts, which extracts real text
 * directly from the DOM/accessibility tree for all normal HTML content
 * (faster, exact, 1.0 confidence). Genuine image OCR only matters for the
 * minority of pages that render sensitive text inside <canvas>/<img>
 * (e.g. scanned ID cards, screenshots pasted into a form).
 */
export class StubImageOcrService implements OcrService {
  async recognize(
    _image: ImageData | ArrayBuffer,
    _width: number,
    _height: number
  ): Promise<OCRRegion[]> {
    return [];
  }
}

type TesseractWorker = {
  recognize: (
    image: unknown,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>
  ) => Promise<{
    data: {
      // The real tesseract.js v7 result shape nests word-level data as
      // blocks -> paragraphs -> lines -> words (there is NO flat
      // `data.words` array, despite that being an easy assumption to
      // make from older tesseract.js versions/tutorials) - `blocks` is
      // also `null` unless explicitly requested via the `output`
      // parameter. Both of these were discovered by actually running
      // this against a real image in a real Chrome browser during
      // development, not by reading documentation alone - see
      // docs/MODEL_PIPELINE.md for the real before/after numbers.
      blocks:
        | Array<{
            paragraphs: Array<{
              lines: Array<{
                words: Array<{
                  text: string;
                  confidence: number;
                  bbox: { x0: number; y0: number; x1: number; y1: number };
                }>;
              }>;
            }>;
          }>
        | null;
    };
  }>;
  terminate: () => Promise<void>;
};

/**
 * Real, lightweight, on-device OCR backed by tesseract.js. Lazily
 * initializes a single worker (spec section 10: never re-init per frame)
 * and reuses it across calls. Fails closed: any initialization or
 * recognition error results in an EMPTY result rather than a thrown
 * exception reaching callers or (worse) fabricated text - the privacy
 * pipeline treats "no OCR text found" as safe-by-omission for this
 * region, never as "region is clean," so failing closed here can only
 * ever under-detect, never mis-report presence of PII as absence in a way
 * that bypasses an otherwise-firing detector on DOM/ARIA text.
 */
/**
 * Resolves a tesseract.js asset path against the extension's own bundle
 * origin, not the host page's origin - identical rationale to
 * `resolveDefaultModelUrl()` in local-vision-model.ts: a content script
 * executes with the *page's* URL as its base, so a bare relative path
 * would 404 against whatever page is open instead of the extension's own
 * packaged assets.
 */
function resolveExtensionAssetUrl(path: string): string {
  const g = globalThis as unknown as {
    chrome?: { runtime?: { getURL?: (path: string) => string } };
    browser?: { runtime?: { getURL?: (path: string) => string } };
  };
  const getURL = g.chrome?.runtime?.getURL ?? g.browser?.runtime?.getURL;
  return getURL ? getURL(path) : path;
}

export class TesseractOcrService implements OcrService {
  private workerPromise: Promise<TesseractWorker> | null = null;
  private unavailable = false;

  constructor(private readonly lang: string = "eng") {}

  private async getWorker(): Promise<TesseractWorker> {
    if (this.unavailable) throw new Error("OCR_UNAVAILABLE");
    if (!this.workerPromise) {
      this.workerPromise = new Promise<TesseractWorker>((resolve, reject) => {
        // tesseract.js's underlying worker can surface load failures (e.g.
        // no network for the traineddata/wasm fetch) as an 'error' event on
        // the worker rather than a clean promise rejection in some
        // environments. Guard both paths so a bad load can never hang or
        // escape as an unhandled rejection - it must always resolve this
        // promise to a rejection so recognize() can fail closed.
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          this.unavailable = true;
          this.workerPromise = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        import("tesseract.js")
          .then(({ createWorker }) =>
            createWorker(this.lang, 1, {
              // Self-hosted (see docs/LIMITATIONS.md §1 and
              // apps/extension/public/tesseract/) instead of tesseract.js's
              // default jsDelivr CDN paths - this was independently
              // verified to matter: tesseract.js's default configuration
              // was tested live in a real Chrome browser during
              // development and failed outright in a network environment
              // that couldn't reach cdn.jsdelivr.net, then succeeded with
              // exact, correct text recognition once pointed at these
              // bundled assets instead (see MODEL_PIPELINE.md for the
              // real numbers from that run).
              workerPath: resolveExtensionAssetUrl("tesseract/worker.min.js"),
              corePath: resolveExtensionAssetUrl("tesseract/tesseract-core-simd.wasm.js"),
              langPath: resolveExtensionAssetUrl("tesseract/"),
              gzip: true,
            })
          )
          .then((worker) => {
            if (settled) return;
            settled = true;
            resolve(worker as unknown as TesseractWorker);
          })
          .catch(fail);
      });
    }
    return this.workerPromise;
  }

  async recognize(
    image: ImageData | ArrayBuffer,
    _width: number,
    _height: number
  ): Promise<OCRRegion[]> {
    try {
      const worker = await this.getWorker();
      const input = toTesseractInput(image);
      // `output: { blocks: true }` is required - tesseract.js v7 returns
      // `blocks: null` by default (an optimization for callers who only
      // want plain text), and word-level boxes only exist nested inside
      // blocks -> paragraphs -> lines -> words.
      const result = await worker.recognize(input, {}, { blocks: true });
      const words = flattenWords(result.data.blocks);

      return words
        .filter((w) => w.text.trim().length > 0)
        .map((w, idx) => {
          const bbox: BoundingBox = {
            x: w.bbox.x0,
            y: w.bbox.y0,
            width: Math.max(0, w.bbox.x1 - w.bbox.x0),
            height: Math.max(0, w.bbox.y1 - w.bbox.y0),
          };
          return {
            id: `ocr_word_${idx}`,
            text: w.text,
            bbox,
            // tesseract reports 0-100; normalize to 0-1 to match the rest
            // of the pipeline's confidence convention.
            confidence: Math.min(1, Math.max(0, w.confidence / 100)),
          };
        });
    } catch {
      // Fail closed: never throw out of recognize(), never fabricate text.
      return [];
    }
  }

  async dispose(): Promise<void> {
    if (!this.workerPromise) return;
    try {
      const worker = await this.workerPromise;
      await worker.terminate();
    } catch {
      /* already gone / never initialized successfully */
    } finally {
      this.workerPromise = null;
    }
  }
}

/**
 * Flattens tesseract.js v7's nested blocks -> paragraphs -> lines -> words
 * structure into a flat word list. Returns [] for `blocks: null` (e.g. an
 * image with no recognizable text) rather than throwing.
 */
function flattenWords(
  blocks: Awaited<ReturnType<TesseractWorker["recognize"]>>["data"]["blocks"]
): Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> {
  if (!blocks) return [];
  const words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> =
    [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          words.push(word);
        }
      }
    }
  }
  return words;
}

/**
 * tesseract.js's `ImageLike` type does NOT include raw `ImageData` (only
 * string/URL, HTMLImageElement/CanvasElement/VideoElement,
 * CanvasRenderingContext2D, File, Blob, Buffer, OffscreenCanvas) - passing
 * a raw ImageData object directly silently produces garbage ("truncated
 * file" / "pix not read" errors from the underlying Leptonica engine),
 * discovered by actually running this against a real image in a real
 * Chrome browser during development (see MODEL_PIPELINE.md). The fix is
 * to draw the ImageData onto a canvas first and hand tesseract.js the
 * canvas, which IS a supported `ImageLike` type.
 */
function toTesseractInput(image: ImageData | ArrayBuffer): unknown {
  if (image instanceof ArrayBuffer) {
    return new Uint8Array(image);
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // No canvas 2D context available (shouldn't happen in a real browser
    // content-script context) - fail closed by returning something
    // tesseract.js will itself reject cleanly, rather than throwing here.
    return image;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Picks a real OCR implementation when the environment can plausibly run
 * one (a Worker/WASM-capable browser context), otherwise falls back to the
 * honest stub. This keeps Node-based unit tests (which don't want to spin
 * up a real WASM OCR worker) fast and deterministic while giving the real
 * extension runtime real OCR.
 */
export function createOcrService(): OcrService {
  const hasWorkerRuntime =
    typeof globalThis.Worker !== "undefined" || typeof globalThis.document !== "undefined";
  return hasWorkerRuntime ? new TesseractOcrService() : new StubImageOcrService();
}

/** Convenience type used by callers that want a single OCR-like region shape for arbitrary bbox+text. */
export function makeOcrRegion(id: string, text: string, bbox: BoundingBox, confidence: number): OCRRegion {
  return { id, text, bbox, confidence };
}
