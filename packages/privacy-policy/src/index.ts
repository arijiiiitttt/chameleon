import type {
  PolicyAction,
  PrivacyFinding,
  PrivacyPolicy,
  Severity,
} from "@chameleon/shared-types";
import { DEFAULT_PRIVACY_POLICY } from "@chameleon/shared-types";

export const PRIVACY_POLICY_VERSION = "1.0";

/** Base sensitivity weight per category (spec: risk = sensitivity x confidence x exposure x context) */
const SENSITIVITY_WEIGHT: Record<string, number> = {
  PASSWORD: 1.0,
  OTP: 1.0,
  API_KEY: 1.0,
  ACCESS_TOKEN: 1.0,
  SECRET: 1.0,
  CREDIT_CARD: 0.95,
  FINANCIAL: 0.9,
  FACE: 0.75,
  IDENTIFIER: 0.7,
  EMPLOYEE_ID: 0.65,
  ADDRESS: 0.6,
  DOCUMENT: 0.6,
  PHONE: 0.5,
  EMAIL: 0.45,
  PERSON: 0.4,
  OTHER: 0.3,
  PUBLIC_TEXT: 0.05,
  UI_STRUCTURE: 0.0,
};

export interface RiskContext {
  /** 1.0 if this data would leave the device (network-bound), lower if purely local */
  exposure: number;
  /** contextual multiplier, e.g. higher if inside a form labelled "login" */
  contextMultiplier: number;
}

export function computeRisk(finding: PrivacyFinding, ctx: RiskContext): number {
  const weight = SENSITIVITY_WEIGHT[finding.category] ?? 0.5;
  const risk = weight * finding.confidence * ctx.exposure * ctx.contextMultiplier;
  return Math.min(1, Math.max(0, risk));
}

export function severityFromRisk(risk: number): Severity {
  if (risk >= 0.85) return "CRITICAL";
  if (risk >= 0.6) return "HIGH";
  if (risk >= 0.3) return "MEDIUM";
  return "LOW";
}

export class PrivacyPolicyEngine {
  private policy: PrivacyPolicy;

  constructor(policy: PrivacyPolicy = DEFAULT_PRIVACY_POLICY) {
    this.policy = { ...policy };
  }

  getPolicy(): PrivacyPolicy {
    return { ...this.policy };
  }

  setPolicy(next: Partial<PrivacyPolicy>): void {
    this.policy = { ...this.policy, ...next };
  }

  /**
   * Decide the action for a finding. Fail-closed (spec section 51): if the
   * category is somehow not present in the policy table, default to MASK
   * rather than ALLOW.
   */
  decide(finding: PrivacyFinding): PolicyAction {
    return this.policy[finding.category] ?? "MASK";
  }

  /**
   * Fail-closed helper used when any upstream detector/redactor throws.
   * Per spec section 51, a pipeline failure must never result in raw data
   * being transmitted - the caller should treat this as BLOCK for the
   * whole payload, not just the failed finding.
   */
  static failClosedAction(): PolicyAction {
    return "BLOCK";
  }
}
