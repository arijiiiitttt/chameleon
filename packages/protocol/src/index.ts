import { z } from "zod";

export const SanitizedElementSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.string().min(1).max(64),
  label: z.string().max(256),
  value: z.string().max(256).optional(),
  interactive: z.boolean(),
  redacted: z.boolean(),
});

export const RedactedScreenshotSchema = z.object({
  dataUrl: z.string().startsWith("data:image/"),
  width: z.number().int().positive().max(2000),
  height: z.number().int().positive().max(2000),
});

export const SanitizedScreenSchema = z.object({
  pageType: z.string().max(128),
  elements: z.array(SanitizedElementSchema).max(500),
  redactedScreenshot: RedactedScreenshotSchema.optional(),
});

export const PrivacySummarySchema = z.object({
  sanitized: z.literal(true), // server refuses to process anything not marked sanitized
  findings: z.number().int().min(0),
  redacted: z.number().int().min(0),
  blocked: z.number().int().min(0),
});

export const SanitizedRequestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  requestId: z.string().min(1).max(128),
  userIntent: z.string().min(1).max(2000),
  screen: SanitizedScreenSchema,
  privacy: PrivacySummarySchema,
  privacyPolicyVersion: z.string().min(1),
  agentState: z
    .object({
      iteration: z.number().int().min(0),
      maxIterations: z.number().int().min(1),
    })
    .optional(),
});

export type SanitizedRequestValidated = z.infer<typeof SanitizedRequestSchema>;

/**
 * Server-side "sanity" re-check (spec section 23: "server must still perform
 * basic sanity validation" even though it trusts the client marked the
 * payload sanitized). This is a coarse, independent pattern scan - it is
 * NOT a substitute for the client-side firewall, only a second layer.
 */
const RAW_PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "EMAIL", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: "PHONE", pattern: /(?:\+?\d{1,3}[-.\s]?)?(?:\d{10}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4})/ },
  { name: "CREDIT_CARD", pattern: /\b(?:\d[ -]*?){13,19}\b/ },
];

export interface ServerSanityResult {
  ok: boolean;
  violations: string[];
}

export function serverSideSanityScan(payload: unknown): ServerSanityResult {
  const serialized = JSON.stringify(payload);
  const violations: string[] = [];
  for (const { name, pattern } of RAW_PII_PATTERNS) {
    if (pattern.test(serialized)) {
      violations.push(name);
    }
  }
  return { ok: violations.length === 0, violations };
}
