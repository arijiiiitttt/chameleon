import { config } from "../config/config.js";
import { MockReasoningProvider } from "./mock-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ReasoningProvider } from "./types.js";

export function createReasoningProvider(): ReasoningProvider {
  if (config.aiProvider === "openai-compatible") {
    if (!config.aiBaseUrl || !config.aiModel || !config.aiApiKey) {
      throw new Error(
        "AI_PROVIDER=openai-compatible requires AI_BASE_URL, AI_MODEL, and AI_API_KEY to be set."
      );
    }
    return new OpenAiCompatibleProvider({
      baseUrl: config.aiBaseUrl,
      model: config.aiModel,
      apiKey: config.aiApiKey,
      visionEnabled: config.aiVisionEnabled,
    });
  }
  return new MockReasoningProvider();
}
