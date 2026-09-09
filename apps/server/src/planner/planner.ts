import type { SanitizedRequestValidated } from "../shared/protocol.js";
import { ActionPlanSchema, type ActionPlan } from "../shared/action-dsl.js";
import type { ReasoningProvider } from "../providers/types.js";

export class PlannerError extends Error {}

/**
 * Even though each ReasoningProvider is expected to return a validated
 * ActionPlan already, the planner re-validates independently - defense in
 * depth against a provider bug or a future provider that skips validation.
 */
export class Planner {
  constructor(private provider: ReasoningProvider, private maxAttempts = 2) {}

  async plan(context: SanitizedRequestValidated): Promise<ActionPlan> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const rawPlan = await this.provider.generatePlan(context);
        const result = ActionPlanSchema.safeParse(rawPlan);
        if (!result.success) {
          throw new PlannerError("PLANNER_PRODUCED_INVALID_ACTION_PLAN");
        }
        // Smaller/free models are unreliable at literally echoing back an
        // opaque ID even when explicitly instructed to - they'll often
        // invent a plausible-looking one instead (e.g. a fake timestamp-style
        // ID) rather than copying the exact string. The server is already
        // the trusted source of truth for requestId (it generated it), so
        // rather than rejecting an otherwise-valid plan over this cosmetic
        // mismatch, log it for visibility and overwrite with the trusted
        // value before returning.
        if (result.data.requestId !== context.requestId) {
          // eslint-disable-next-line no-console
          console.warn(
            `[chameleon server] requestId mismatch (model did not echo it correctly). ` +
              `Expected: "${context.requestId}", model returned: "${result.data.requestId}". ` +
              `Overwriting with the trusted server-side value.`
          );
        }
        return { ...result.data, requestId: context.requestId };
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(
          `[chameleon server] plan attempt ${attempt}/${this.maxAttempts} failed: ${
            err instanceof Error ? err.message : String(err)
          }${attempt < this.maxAttempts ? " - retrying..." : ""}`
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new PlannerError("PLANNER_FAILED_AFTER_RETRIES");
  }
}