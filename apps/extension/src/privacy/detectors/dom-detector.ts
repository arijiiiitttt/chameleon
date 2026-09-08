import type { PrivacyFinding, ScreenElement, SensitivityType } from "@chameleon/shared-types";

/**
 * Detects sensitivity from DOM/ARIA semantics attached to a ScreenElement -
 * input type, autocomplete hints, name attributes, aria-label, placeholder.
 * This detector never needs to read the element's live text value beyond
 * the metadata already captured during DOM extraction, so it is cheap to
 * run on every fused ScreenState.
 */

export interface DomSignal {
  elementId: string;
  inputType?: string;
  autocomplete?: string;
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
}

const INPUT_TYPE_MAP: Record<string, SensitivityType> = {
  password: "PASSWORD",
  email: "EMAIL",
  tel: "PHONE",
};

const AUTOCOMPLETE_MAP: Array<{ pattern: RegExp; category: SensitivityType }> = [
  { pattern: /^cc-number$|^cc-/, category: "FINANCIAL" },
  { pattern: /^email$/, category: "EMAIL" },
  { pattern: /^tel/, category: "PHONE" },
  { pattern: /^street-address|^address/, category: "ADDRESS" },
  { pattern: /^name$|^given-name$|^family-name$/, category: "PERSON" },
  { pattern: /^one-time-code$/, category: "OTP" },
];

const NAME_ATTR_MAP: Array<{ pattern: RegExp; category: SensitivityType }> = [
  { pattern: /email/i, category: "EMAIL" },
  { pattern: /pass(word)?/i, category: "PASSWORD" },
  { pattern: /phone|mobile|tel/i, category: "PHONE" },
  { pattern: /addr(ess)?/i, category: "ADDRESS" },
  { pattern: /otp|one.?time/i, category: "OTP" },
  { pattern: /card.?number|cvv|ccv/i, category: "CREDIT_CARD" },
  { pattern: /ssn|aadhaar|passport|national.?id/i, category: "IDENTIFIER" },
  { pattern: /employee.?id|emp.?id|staff.?id/i, category: "EMPLOYEE_ID" },
  { pattern: /api.?key/i, category: "API_KEY" },
  { pattern: /access.?token|bearer.?token|auth.?token/i, category: "ACCESS_TOKEN" },
  { pattern: /secret/i, category: "SECRET" },
];

function classify(signal: DomSignal): { category: SensitivityType; confidence: number } | null {
  if (signal.inputType && INPUT_TYPE_MAP[signal.inputType]) {
    return { category: INPUT_TYPE_MAP[signal.inputType]!, confidence: 0.99 };
  }

  if (signal.autocomplete) {
    for (const { pattern, category } of AUTOCOMPLETE_MAP) {
      if (pattern.test(signal.autocomplete)) {
        return { category, confidence: 0.95 };
      }
    }
  }

  const haystack = [signal.name, signal.ariaLabel, signal.placeholder]
    .filter(Boolean)
    .join(" ");

  if (haystack) {
    for (const { pattern, category } of NAME_ATTR_MAP) {
      if (pattern.test(haystack)) {
        return { category, confidence: 0.8 };
      }
    }
  }

  return null;
}

export function detectDomSensitivity(
  signals: DomSignal[],
  elements: ScreenElement[]
): PrivacyFinding[] {
  const elementIndex = new Map(elements.map((e) => [e.id, e]));
  const findings: PrivacyFinding[] = [];

  for (const signal of signals) {
    const result = classify(signal);
    if (!result) continue;
    const element = elementIndex.get(signal.elementId);

    findings.push({
      id: `dom_${signal.elementId}`,
      category: result.category,
      bbox: element?.bbox,
      confidence: result.confidence,
      severity: "MEDIUM", // finalized later by the risk engine, which also considers confidence/exposure
      sources: ["DOM"],
    });
  }

  return findings;
}
