import type { PolicyAction, PrivacyFinding, SanitizationManifestEntry } from "@chameleon/shared-types";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import type { PrivacyVault } from "../privacy/vault/privacy-vault.js";

export interface RedactTextInput {
  regionId: string;
  text: string;
  findings: PrivacyFinding[]; // findings whose textRange falls within this text
}

export interface RedactedTextResult {
  regionId: string;
  sanitizedText: string;
  manifestEntries: SanitizationManifestEntry[];
  blocked: boolean;
}

function maskSpan(length: number): string {
  return "\u2588".repeat(Math.max(4, Math.min(length, 24)));
}

/**
 * Applies the policy engine's decision to each finding within a text region,
 * replacing spans with a mask or a vault token. Raw values that get
 * tokenized are written to the vault and NEVER appear in `sanitizedText`.
 */
export async function redactText(
  input: RedactTextInput,
  policy: PrivacyPolicyEngine,
  vault: PrivacyVault
): Promise<RedactedTextResult> {
  const manifestEntries: SanitizationManifestEntry[] = [];
  let blocked = false;

  // Process spans back-to-front so earlier offsets remain valid while we splice.
  const ordered = [...input.findings]
    .filter((f) => f.textRange)
    .sort((a, b) => b.textRange!.start - a.textRange!.start);

  let text = input.text;

  for (const finding of ordered) {
    const action: PolicyAction = policy.decide(finding);
    const { start, end } = finding.textRange!;
    const rawValue = text.slice(start, end);

    switch (action) {
      case "ALLOW":
        break;
      case "BLOCK":
        blocked = true;
        text = text.slice(0, start) + maskSpan(rawValue.length) + text.slice(end);
        manifestEntries.push({ id: finding.id, category: finding.category, action });
        break;
      case "MASK":
      case "BLUR": // text has no visual blur equivalent - fall back to mask
        text = text.slice(0, start) + maskSpan(rawValue.length) + text.slice(end);
        manifestEntries.push({ id: finding.id, category: finding.category, action: "MASK" });
        break;
      case "TOKENIZE": {
        const token = await vault.tokenize(finding.category, rawValue);
        text = text.slice(0, start) + `[${token}]` + text.slice(end);
        manifestEntries.push({ id: finding.id, category: finding.category, action, token });
        break;
      }
    }
  }

  return { regionId: input.regionId, sanitizedText: text, manifestEntries, blocked };
}
