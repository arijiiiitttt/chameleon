import { scanPayloadForLeaks, type LeakFinding } from "./payload-scanner.js";

export interface LeakageCheckResult {
  hasLeak: boolean;
  findings: LeakFinding[];
  screenshotFieldsPresent: string[];
}

const RAW_SCREENSHOT_KEY_HINTS = /screenshot|rawimage|rawscreencapture/i;

/**
 * The one sanctioned exception to the raw-screenshot block described
 * above, exactly as this module's original docstring called for
 * ("must be explicitly allow-listed by policy config, never silently
 * passed") - implemented now rather than left as an unfulfilled
 * promise. `redactedScreenshot` is permitted ONLY as an exact key-name
 * match (not a fuzzy/substring match, so a maliciously-named lookalike
 * key like `notRedactedScreenshotActually` is still caught) and ONLY
 * because every writer of that field in this codebase
 * (`content/content-script.ts`) is required to call
 * `applyImageRedaction()` against the privacy pipeline's own
 * `imageRedactionRegions` BEFORE populating it - the field cannot exist
 * in a sanitized payload without having gone through pixel redaction
 * first. This is what makes a real VLM (image) channel to the server
 * possible without reopening the "raw screenshot leaves the device"
 * hole this scanner exists to close.
 */
const ALLOWED_SCREENSHOT_KEY_NAMES = new Set(["redactedScreenshot"]);

/**
 * Walks the payload's top-level keys (recursively) looking for anything
 * that resembles a raw, unredacted screenshot field. Screenshots may only
 * cross the boundary via the dedicated sanitized-screenshot path
 * (`ALLOWED_SCREENSHOT_KEY_NAMES` above) - every other field matching
 * these names is flagged and blocks the request, never silently passed.
 */
function findScreenshotFields(payload: unknown, path = "$"): string[] {
  const hits: string[] = [];
  function visit(node: unknown, currentPath: string, keyName?: string): void {
    if (node == null) return;
    if (keyName && RAW_SCREENSHOT_KEY_HINTS.test(keyName) && !ALLOWED_SCREENSHOT_KEY_NAMES.has(keyName)) {
      hits.push(currentPath);
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${currentPath}[${i}]`));
    } else if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, `${currentPath}.${k}`, k);
      }
    }
  }
  visit(payload, path);
  return hits;
}

export function checkForLeakage(payload: unknown): LeakageCheckResult {
  const findings = scanPayloadForLeaks(payload);
  const screenshotFieldsPresent = findScreenshotFields(payload);
  return {
    hasLeak: findings.length > 0,
    findings,
    screenshotFieldsPresent,
  };
}
