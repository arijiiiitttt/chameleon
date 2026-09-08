/**
 * Everything in this file describes the SANITIZED wire format.
 * Nothing here may contain raw PII - that invariant is enforced by the
 * privacy firewall (apps/extension/src/firewall) before a payload is
 * constructed from these shapes, and re-checked by server-side schema
 * validation (apps/server/src/schemas).
 */

export interface SanitizedElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  interactive: boolean;
  redacted: boolean;
}

export interface SanitizedScreen {
  pageType: string;
  elements: SanitizedElement[];
  /**
   * Optional VLM (vision-language model) channel: a small, already
   * pixel-redacted screenshot as a data URL. Populated ONLY by
   * `content-script.ts`, and ONLY after running the captured tab image
   * through `applyImageRedaction()` against the privacy pipeline's own
   * `imageRedactionRegions` (faces/documents blurred/boxed) - by
   * construction, this field can never carry an unredacted screenshot,
   * which is what makes it exempt from the outbound firewall's otherwise
   * absolute raw-screenshot block (see
   * `firewall/leakage-detector.ts`'s exact-name allowlist). Optional and
   * opt-in server-side (`AI_VISION_ENABLED`) - omitted entirely when the
   * server-side provider doesn't support vision, so this never becomes a
   * mandatory/always-on network payload increase.
   */
  redactedScreenshot?: {
    dataUrl: string;
    width: number;
    height: number;
  };
}

export interface PrivacySummary {
  sanitized: boolean;
  findings: number;
  redacted: number;
  blocked: number;
}

export interface SanitizedRequest {
  schemaVersion: "1.0";
  requestId: string;
  userIntent: string;
  screen: SanitizedScreen;
  privacy: PrivacySummary;
  privacyPolicyVersion: string;
  /** optional agent state, never contains PII */
  agentState?: {
    iteration: number;
    maxIterations: number;
  };
}

export interface ActionPlanResponse {
  requestId: string;
  actions: unknown[]; // typed precisely by @chameleon/action-dsl on both ends
  rationale?: string;
  confidence: number;
}
