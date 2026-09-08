import type { SanitizedRequestValidated } from "../shared/protocol.js";
import type { ActionPlan } from "../shared/action-dsl.js";

export interface ReasoningProvider {
  generatePlan(context: SanitizedRequestValidated): Promise<ActionPlan>;
}
