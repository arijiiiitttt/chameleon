import type { Request, Response } from "express";
import { SanitizedRequestSchema, serverSideSanityScan } from "../shared/protocol.js";
import { Planner } from "../planner/planner.js";
import type { ReasoningProvider } from "../providers/types.js";
import { TypedError } from "../middleware/security.js";

export function createReasonHandler(provider: ReasoningProvider) {
  const planner = new Planner(provider);

  return async function reasonHandler(req: Request, res: Response): Promise<void> {
    const parsed = SanitizedRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TypedError("SCHEMA_VALIDATION_FAILED", 400);
    }

    // Server-side sanity re-check (spec section 23): coarse pattern scan as
    // a second layer of defense even though the client firewall already ran.
    const sanity = serverSideSanityScan(parsed.data);
    if (!sanity.ok) {
      throw new TypedError("SERVER_SANITY_CHECK_FAILED", 400);
    }

    try {
      const plan = await planner.plan(parsed.data);
      res.json(plan);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[chameleon server] planner failed:", err);
      const message = err instanceof Error ? err.message : "Unknown planner error";
      throw new TypedError(`PLANNER_FAILED: ${message}`, 502);
    }
  };
}