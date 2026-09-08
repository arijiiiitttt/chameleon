import type { NextFunction, Request, Response } from "express";
import { config } from "../config/config.js";

export class TypedError extends Error {
  constructor(public code: string, public status = 400, message?: string) {
    super(message ?? code);
  }
}

/** Enforces the context budget's max payload size (spec section 60) at the transport layer. */
export function requestSizeGuard(req: Request, _res: Response, next: NextFunction): void {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength > config.maxRequestBytes) {
    next(new TypedError("PAYLOAD_TOO_LARGE", 413));
    return;
  }
  next();
}

/** Structured error handler - never echoes back raw request bodies or stack traces that might contain sensitive text. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof TypedError) {
    res.status(err.status).json({ error: { code: err.code } });
    return;
  }
  res.status(500).json({ error: { code: "INTERNAL_ERROR" } });
}
