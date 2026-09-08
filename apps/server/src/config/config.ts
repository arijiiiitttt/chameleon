import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.string().default("8787"),
  AI_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
  AI_BASE_URL: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  // Opt-in VLM (vision-language model) support: when "true", the
  // openai-compatible provider will include the client's already
  // pixel-redacted screenshot (if the request has one) as an image
  // content block. Defaults to "false" - most OpenAI-compatible
  // endpoints/models are text-only, and silently sending an image block
  // to a model that doesn't expect one is a real way to break requests,
  // so this is explicit opt-in, not auto-detected.
  AI_VISION_ENABLED: z.string().default("false"),
  CORS_ORIGIN: z.string().default("*"),
  MAX_REQUEST_BYTES: z.string().default("262144"), // 256 KB - context budget (spec section 60)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid server configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  port: Number(parsed.data.PORT),
  aiProvider: parsed.data.AI_PROVIDER,
  aiBaseUrl: parsed.data.AI_BASE_URL,
  aiModel: parsed.data.AI_MODEL,
  aiApiKey: parsed.data.AI_API_KEY,
  aiVisionEnabled: parsed.data.AI_VISION_ENABLED === "true",
  corsOrigin: parsed.data.CORS_ORIGIN,
  maxRequestBytes: Number(parsed.data.MAX_REQUEST_BYTES),
};
