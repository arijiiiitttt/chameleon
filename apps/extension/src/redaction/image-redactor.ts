import type { RedactionRegion } from "./bbox-redactor.js";

/**
 * Applies black-box / pixelate-blur / mask styling to the given regions of
 * a canvas, in place. This runs after `planBboxRedaction` and before the
 * resulting image is ever considered for the firewall - never the reverse.
 */
export function applyImageRedaction(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  regions: RedactionRegion[]
): void {
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("REDACTION_FAILED");

  for (const region of regions) {
    const { x, y, width, height } = region.bbox;

    if (region.style === "BLACK_BOX" || region.style === "MASK") {
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, width, height);
      continue;
    }

    if (region.style === "PIXELATE_BLUR") {
      // Simple block-pixelation: downsample the region then scale back up.
      const blockSize = Math.max(6, Math.floor(Math.min(width, height) / 8));
      const imageData = ctx.getImageData(x, y, width, height);
      for (let by = 0; by < height; by += blockSize) {
        for (let bx = 0; bx < width; bx += blockSize) {
          const idx = (by * width + bx) * 4;
          const r = imageData.data[idx] ?? 0;
          const g = imageData.data[idx + 1] ?? 0;
          const b = imageData.data[idx + 2] ?? 0;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x + bx, y + by, blockSize, blockSize);
        }
      }
    }
  }
}
