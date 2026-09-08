import type { BoundingBox, TextRange } from "./geometry.js";

export type SensitivityType =
  | "PASSWORD"
  | "EMAIL"
  | "PHONE"
  | "PERSON"
  | "FACE"
  | "ADDRESS"
  | "IDENTIFIER"
  | "EMPLOYEE_ID"
  | "FINANCIAL"
  | "CREDIT_CARD"
  | "OTP"
  | "API_KEY"
  | "ACCESS_TOKEN"
  | "SECRET"
  | "DOCUMENT"
  | "PUBLIC_TEXT"
  | "UI_STRUCTURE"
  | "OTHER";

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type DetectionSource =
  | "DOM"
  | "REGEX"
  | "OCR"
  | "NER"
  | "VISION";

export interface PrivacyFinding {
  id: string;
  category: SensitivityType;
  bbox?: BoundingBox;
  textRange?: TextRange;
  /** raw text is intentionally NOT part of this type - findings must never carry raw PII beyond the local pipeline */
  confidence: number;
  severity: Severity;
  sources: DetectionSource[];
}

export type PolicyAction = "ALLOW" | "MASK" | "BLUR" | "TOKENIZE" | "BLOCK";

export type PrivacyPolicy = Record<SensitivityType, PolicyAction>;

export const DEFAULT_PRIVACY_POLICY: PrivacyPolicy = {
  PASSWORD: "BLOCK",
  OTP: "BLOCK",
  API_KEY: "BLOCK",
  ACCESS_TOKEN: "BLOCK",
  SECRET: "BLOCK",
  CREDIT_CARD: "MASK",
  FINANCIAL: "MASK",
  EMAIL: "TOKENIZE",
  PHONE: "TOKENIZE",
  PERSON: "TOKENIZE",
  FACE: "BLUR",
  ADDRESS: "MASK",
  IDENTIFIER: "MASK",
  EMPLOYEE_ID: "TOKENIZE",
  DOCUMENT: "MASK",
  PUBLIC_TEXT: "ALLOW",
  UI_STRUCTURE: "ALLOW",
  OTHER: "MASK",
};

export interface SanitizationManifestEntry {
  id: string;
  category: SensitivityType;
  action: PolicyAction;
  /** token assigned when action === TOKENIZE, e.g. EMAIL_1 */
  token?: string;
}

export interface SanitizationManifest {
  policyVersion: string;
  entries: SanitizationManifestEntry[];
}
