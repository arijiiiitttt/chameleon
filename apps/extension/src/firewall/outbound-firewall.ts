import { checkForLeakage } from "./leakage-detector.js";

export type FirewallDecision =
  | { allowed: true }
  | { allowed: false; reason: string; details: unknown };

/**
 * SECURITY INVARIANT (spec sections 20, 51, 82-INVARIANT-7):
 * EVERY agent-controlled outbound request must call `inspect()` first.
 * If inspection itself throws for any reason, the firewall fails CLOSED
 * (blocks) rather than allowing the request through.
 */
export class OutboundFirewall {
  inspect(payload: unknown): FirewallDecision {
    try {
      const result = checkForLeakage(payload);

      if (result.screenshotFieldsPresent.length > 0) {
        return {
          allowed: false,
          reason: "UNSANITIZED_SCREENSHOT_FIELD_DETECTED",
          details: { fields: result.screenshotFieldsPresent },
        };
      }

      if (result.hasLeak) {
        return {
          allowed: false,
          reason: "RAW_PII_DETECTED",
          details: {
            categories: Array.from(new Set(result.findings.map((f) => f.category))),
            count: result.findings.length,
          },
        };
      }

      return { allowed: true };
    } catch (err) {
      // Fail-closed: an internal firewall error must never be treated as "safe".
      return {
        allowed: false,
        reason: "FIREWALL_INTERNAL_ERROR_FAIL_CLOSED",
        details: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
