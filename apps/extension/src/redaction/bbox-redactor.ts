import type { BoundingBox, PolicyAction, PrivacyFinding } from "@chameleon/shared-types";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";

export interface RedactionRegion {
  findingId: string;
  bbox: BoundingBox;
  style: "BLACK_BOX" | "PIXELATE_BLUR" | "MASK";
}

/**
 * Computes the set of image regions that MUST be visually redacted before
 * a screenshot is allowed anywhere near the firewall. This module only
 * computes the plan - actual pixel manipulation happens on an
 * OffscreenCanvas in the content script (see image-redactor.ts) since
 * canvas APIs aren't available in this Node-testable module.
 */
export function planBboxRedaction(
  findings: PrivacyFinding[],
  policy: PrivacyPolicyEngine
): RedactionRegion[] {
  const regions: RedactionRegion[] = [];

  for (const finding of findings) {
    if (!finding.bbox) continue;
    const action: PolicyAction = policy.decide(finding);

    let style: RedactionRegion["style"] | null = null;
    switch (action) {
      case "BLOCK":
      case "MASK":
        style = finding.category === "PASSWORD" ? "BLACK_BOX" : "MASK";
        break;
      case "BLUR":
        style = "PIXELATE_BLUR";
        break;
      case "TOKENIZE":
        style = "MASK"; // the image itself still shows a mask; the *text* representation carries the token
        break;
      case "ALLOW":
        style = null;
        break;
    }

    if (style) {
      regions.push({ findingId: finding.id, bbox: finding.bbox, style });
    }
  }

  return regions;
}
