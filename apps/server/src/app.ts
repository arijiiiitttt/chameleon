import express from "express";
import cors from "cors";
import { config } from "./config/config.js";
import { requestSizeGuard, errorHandler } from "./middleware/security.js";
import { createReasonHandler } from "./api/reason.js";
import { createReasoningProvider } from "./providers/factory.js";

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: `${config.maxRequestBytes}b` }));
  app.use(requestSizeGuard);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", aiProvider: config.aiProvider });
  });

  const provider = createReasoningProvider();
  app.post("/api/v1/reason", (req, res, next) => {
    createReasonHandler(provider)(req, res).catch(next);
  });

  // Typed error handler must be registered last.
  app.use(errorHandler);

  return app;
}
