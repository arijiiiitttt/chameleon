export type LeakCategory = "PASSWORD" | "EMAIL" | "PHONE" | "IDENTIFIER" | "FINANCIAL" | "OTHER_SENSITIVE";

export interface LeakFinding {
  category: LeakCategory;
  path: string;
  sample: string; // truncated, non-reversible sample for audit display - never the full raw value
}

interface ScanPattern {
  category: LeakCategory;
  pattern: RegExp;
}

const SCAN_PATTERNS: ScanPattern[] = [
  { category: "EMAIL", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { category: "PHONE", pattern: /\+?91[-.\s]?\d{10}\b|\b\d{10}\b/ },
  { category: "FINANCIAL", pattern: /\b(?:\d[ -]?){13,19}\b/ },
  { category: "IDENTIFIER", pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
];

// Field-name heuristics: if a key is literally named "password"/"rawEmail" etc.
// and holds a non-empty string, treat it as a leak regardless of pattern match -
// catches leaks that don't match a regex (e.g. non-standard password strings).
const SENSITIVE_KEY_NAMES: Array<{ pattern: RegExp; category: LeakCategory }> = [
  { pattern: /password/i, category: "PASSWORD" },
  { pattern: /rawemail|raw_email/i, category: "EMAIL" },
  { pattern: /rawphone|raw_phone/i, category: "PHONE" },
  { pattern: /ssn|aadhaar|passport/i, category: "IDENTIFIER" },
  { pattern: /cardnumber|cvv|ccv/i, category: "FINANCIAL" },
];

function redactSample(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/**
 * Recursively scans an arbitrary payload (the object about to be
 * JSON.stringify'd and sent over the network) for raw PII. This is the
 * core of the privacy firewall (spec section 20) - it must catch leaks
 * regardless of how deeply nested they are.
 */
export function scanPayloadForLeaks(payload: unknown, path = "$"): LeakFinding[] {
  const findings: LeakFinding[] = [];

  function visit(node: unknown, currentPath: string, keyName?: string): void {
    if (node == null) return;

    // `redactedScreenshot` (see leakage-detector.ts's allowlist for the
    // exact-name rationale) is a small object whose `dataUrl` field is
    // base64-encoded, ALREADY-PIXEL-REDACTED image data, not text -
    // running text-PII regexes against it is both meaningless (there is
    // no natural-language PII encoded in base64 pixel bytes) and
    // actively harmful (a large base64 string, by pure chance of its
    // character distribution, will very likely contain coincidental runs
    // of 10-19 digits that would otherwise trip the PHONE/FINANCIAL/
    // IDENTIFIER patterns below on every single screenshot, permanently
    // blocking the one field that's supposed to work). The skip happens
    // here, at the object level, so it covers the ENTIRE subtree
    // (`dataUrl`, `width`, `height`) - a leaf-only check on a key named
    // exactly "redactedScreenshot" would miss the nested "dataUrl" key
    // that actually holds the string. This is a narrow, exact-key-name
    // exception, not a general bypass - every other field, at any depth,
    // is still fully scanned.
    if (keyName === "redactedScreenshot") return;

    if (typeof node === "string") {
      if (keyName) {
        for (const { pattern, category } of SENSITIVE_KEY_NAMES) {
          if (pattern.test(keyName) && node.length > 0) {
            findings.push({ category, path: currentPath, sample: redactSample(node) });
          }
        }
      }
      for (const { pattern, category } of SCAN_PATTERNS) {
        if (pattern.test(node)) {
          findings.push({ category, path: currentPath, sample: redactSample(node) });
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${currentPath}[${i}]`));
      return;
    }

    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        visit(v, `${currentPath}.${k}`, k);
      }
    }
  }

  visit(payload, path);
  return findings;
}
