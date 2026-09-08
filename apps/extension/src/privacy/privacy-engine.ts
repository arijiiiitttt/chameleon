import type {
  ScreenState,
  SanitizedRequest,
  SanitizedElement,
  SanitizationManifest,
} from "@chameleon/shared-types";
import { PrivacyPolicyEngine, PRIVACY_POLICY_VERSION } from "@chameleon/privacy-policy";
import { detectDomSensitivity, type DomSignal } from "./detectors/dom-detector.js";
import { detectRegexSensitivity } from "./detectors/regex-detector.js";
import { HeuristicNerDetector } from "./detectors/ner-detector.js";
import { detectVisionSensitivity } from "./detectors/vision-detector.js";
import { classifyFindings } from "./classifier/privacy-classifier.js";
import { redactText } from "../redaction/text-redactor.js";
import { planBboxRedaction, type RedactionRegion } from "../redaction/bbox-redactor.js";
import type { PrivacyVault } from "./vault/privacy-vault.js";
import type { RegionId } from "./types.js";

export interface PrivacyPipelineInput {
  screen: ScreenState;
  domSignals: DomSignal[];
  /** text regions to scan - either DOM text nodes wrapped as OCR-shaped regions, or real OCR output */
  textRegions: Array<{ regionId: RegionId; text: string; source: "DOM" | "OCR" }>;
  userIntent: string;
  requestId: string;
  iteration: number;
  maxIterations: number;
}

export interface PrivacyPipelineOutput {
  sanitizedRequest: SanitizedRequest;
  manifest: SanitizationManifest;
  blockedCount: number;
  /**
   * Bounding-box redaction plan derived from vision-model findings (FACE,
   * DOCUMENT, sensitive-visual-region) plus any DOM findings that carry a
   * bbox. Callers must run this through `applyImageRedaction` on any
   * captured screenshot BEFORE that screenshot is allowed anywhere near
   * the firewall - mirrors the mandatory text-redaction step above but for
   * the pixel channel.
   */
  imageRedactionRegions: RedactionRegion[];
}

const nerDetector = new HeuristicNerDetector();

/**
 * Runs the full local privacy pipeline (spec sections 13-22): detect with
 * every independent detector, merge/classify with confidence boosting,
 * apply the policy engine's redaction decision per finding, and assemble
 * the sanitized wire payload. Nothing produced here has been checked by
 * the firewall yet - that is a separate, mandatory step performed by the
 * caller (agent-loop.ts) immediately after this returns.
 */
export async function runPrivacyPipeline(
  input: PrivacyPipelineInput,
  policy: PrivacyPolicyEngine,
  vault: PrivacyVault
): Promise<PrivacyPipelineOutput> {
  const domFindings = detectDomSensitivity(input.domSignals, input.screen.elements);

  const regexFindings = detectRegexSensitivity(
    input.textRegions.map((r) => ({ regionId: r.regionId, text: r.text, source: r.source }))
  );

  const nerFindings = nerDetector.detect(
    input.textRegions.map((r) => ({ regionId: r.regionId, text: r.text, source: r.source }))
  );

  // Local vision model output (FACE / DOCUMENT / sensitive-visual-region).
  // Empty when no real vision backend is available - see
  // local-vision-model.ts's fail-closed contract - so this is always safe
  // to run unconditionally.
  const visionFindings = detectVisionSensitivity(input.screen.visualRegions);

  const merged = classifyFindings(
    [...domFindings, ...regexFindings, ...nerFindings, ...visionFindings],
    { riskContext: { exposure: 1, contextMultiplier: 1 } }
  );

  const manifest: SanitizationManifest = { policyVersion: PRIVACY_POLICY_VERSION, entries: [] };
  let blockedCount = 0;

  // Redact each text region using ONLY the findings whose id was produced
  // for that region (regex/NER detector ids are prefixed with the region
  // id, e.g. "regex_txt_5_0"; DOM findings use "dom_<elementId>"). Findings
  // must be scoped per-region - otherwise a finding from one element's text
  // could incorrectly redact another element's unrelated text at the same
  // textRange offsets, or unrelated findings could leak into every region.
  const sanitizedTextByRegion = new Map<string, string>();
  for (const region of input.textRegions) {
    const findingsForRegion = merged.filter(
      (f) =>
        f.textRange !== undefined &&
        (f.id.startsWith(`regex_${region.regionId}_`) ||
          f.id.startsWith(`ner_${region.regionId}_`) ||
          f.id === `dom_${region.regionId}`)
    );
    const result = await redactText(
      { regionId: region.regionId, text: region.text, findings: findingsForRegion },
      policy,
      vault
    );
    sanitizedTextByRegion.set(region.regionId, result.sanitizedText);
    manifest.entries.push(...result.manifestEntries);
    if (result.blocked) blockedCount += 1;
  }

  // Build sanitized elements from the redacted text regions (covers both
  // DOM-attribute-based findings like password inputs AND regex/NER
  // findings inside plain text nodes, e.g. "Operator: John Doe").
  //
  // Hidden elements (display:none, visibility:hidden) are EXCLUDED from
  // the outbound representation entirely rather than merely redacted -
  // their content was never rendered for the user to see, so there is no
  // legitimate reason for it to leave the device, and this closes off a
  // known attack surface (a page can embed sensitive text or a
  // prompt-injection payload inside a display:none element to try to
  // reach the reasoning model without appearing on screen).
  const sanitizedElements: SanitizedElement[] = input.screen.elements
    .filter((el) => el.visible)
    .map((el) => {
      const sanitizedText = el.text !== undefined ? sanitizedTextByRegion.get(el.id) : undefined;
      const isRedacted = sanitizedText !== undefined && sanitizedText !== el.text;
      const label = sanitizedText ?? el.ariaLabel ?? el.role;

      return {
        id: el.id,
        role: el.role,
        label,
        value: sanitizedText,
        interactive: el.interactive,
        redacted: isRedacted,
      };
    });

  // Vision-derived, non-sensitive region descriptors (spec: a local vision
  // model should inform DECISIONS, not just redaction). Each classified
  // document/table/chart region becomes a targetable pseudo-element the
  // reasoning server can EXTRACT from, exactly like it would target a DOM
  // element - this is the concrete wiring that makes the vision layer
  // decision-relevant rather than redaction-only. Only the REGION KIND is
  // disclosed ("document region", "table region", "chart region") - never
  // any pixel content, OCR'd text, or bounding-box coordinates, so this
  // cannot leak anything the redaction step didn't already account for.
  // FACE regions are deliberately excluded here: their only legitimate
  // server-facing consequence is redaction (already handled via
  // imageRedactionRegions below), not becoming an actionable target.
  const VISUAL_KIND_LABELS: Partial<Record<string, string>> = {
    document: "Document region",
    table: "Data table region",
    chart: "Chart region",
  };
  const existingIds = new Set(sanitizedElements.map((e) => e.id));
  const visualElements: SanitizedElement[] = input.screen.visualRegions
    .filter(
      (r) =>
        r.backend !== "unavailable" &&
        VISUAL_KIND_LABELS[r.kind] !== undefined &&
        r.sourceElementId &&
        // An <img> is already extracted as a normal DOM element (role
        // "image") by extractDomElements() - avoid emitting a second,
        // duplicate-id entry for it. Only <canvas>-sourced regions (which
        // extractDomElements() never sees at all) need this synthetic
        // element; for an <img> the classification signal is instead
        // folded into its existing element's label below.
        !existingIds.has(r.sourceElementId)
    )
    .map((r) => ({
      id: r.sourceElementId!,
      role: "region",
      label: VISUAL_KIND_LABELS[r.kind]!,
      interactive: false,
      redacted: false,
    }));

  // For <img> elements (already present as normal DOM elements), append
  // the classification as a bracketed suffix to the existing label
  // instead of creating a duplicate entry - e.g. "Scanned form [Document
  // region]" - so the same decision-relevant signal reaches the server
  // either way.
  const sceneLabelByExistingId = new Map<string, string>();
  for (const r of input.screen.visualRegions) {
    const label = VISUAL_KIND_LABELS[r.kind];
    if (r.backend !== "unavailable" && label && r.sourceElementId && existingIds.has(r.sourceElementId)) {
      sceneLabelByExistingId.set(r.sourceElementId, label);
    }
  }
  for (const el of sanitizedElements) {
    const sceneLabel = sceneLabelByExistingId.get(el.id);
    if (sceneLabel) el.label = `${el.label} [${sceneLabel}]`;
  }

  const sanitizedRequest: SanitizedRequest = {
    schemaVersion: "1.0",
    requestId: input.requestId,
    userIntent: input.userIntent,
    screen: {
      pageType: input.screen.page.pageType ?? "unknown",
      elements: [...sanitizedElements, ...visualElements],
    },
    privacy: {
      sanitized: true,
      findings: merged.length,
      redacted: manifest.entries.filter((e) => e.action !== "BLOCK").length,
      blocked: blockedCount,
    },
    privacyPolicyVersion: PRIVACY_POLICY_VERSION,
    agentState: { iteration: input.iteration, maxIterations: input.maxIterations },
  };

  // Vision findings never have a textRange (they describe an image
  // region, not a character span), so they never enter the per-region
  // text-redaction loop above; instead they feed the bbox redaction plan
  // that governs how any screenshot must be pixel-redacted before it can
  // leave the device.
  const imageRedactionRegions = planBboxRedaction(
    merged.filter((f) => f.bbox !== undefined),
    policy
  );

  return { sanitizedRequest, manifest, blockedCount, imageRedactionRegions };
}
