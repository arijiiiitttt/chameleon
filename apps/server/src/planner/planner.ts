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
  constructor(private provider: ReasoningProvider) {}

  async plan(context: SanitizedRequestValidated): Promise<ActionPlan> {
    const rawPlan = await this.provider.generatePlan(context);
    const result = ActionPlanSchema.safeParse(rawPlan);
    if (!result.success) {
      throw new PlannerError("PLANNER_PRODUCED_INVALID_ACTION_PLAN");
    }
    if (result.data.requestId !== context.requestId) {
      throw new PlannerError("PLAN_REQUEST_ID_MISMATCH");
    }
    return result.data;
  }
}
