import type { ScreenCapture } from "@chameleon/shared-types";
import type { BrowserAdapter } from "../../utils/browser-adapter.js";

/**
 * Wraps the browser adapter's captureVisibleTab with the lifecycle
 * guarantees from spec section 5: never uploads automatically, always
 * timestamps, and avoids redundant captures when nothing has changed
 * (paired with DomChangeObserver upstream).
 */
export class CaptureService {
  private lastCapture: ScreenCapture | null = null;
  private lastCaptureAt = 0;
  private readonly minIntervalMs: number;

  constructor(private adapter: BrowserAdapter, minIntervalMs = 500) {
    this.minIntervalMs = minIntervalMs;
  }

  async capture(force = false): Promise<ScreenCapture> {
    const now = Date.now();
    if (!force && this.lastCapture && now - this.lastCaptureAt < this.minIntervalMs) {
      return this.lastCapture;
    }
    const capture = await this.adapter.captureVisibleTab();
    this.lastCapture = capture;
    this.lastCaptureAt = now;
    return capture;
  }
}
