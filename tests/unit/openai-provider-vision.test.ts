import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiCompatibleProvider } from "../../apps/server/src/providers/openai-compatible.js";
import type { SanitizedRequestValidated } from "../../apps/server/src/shared/protocol.js";

/**
 * Proves the VLM (image) channel is real wiring, not just a schema field
 * that goes nowhere: mocks `fetch` and inspects the ACTUAL outgoing
 * request body built by `OpenAiCompatibleProvider.generatePlan()`,
 * asserting the `image_url` content block is present exactly when it
 * should be (vision enabled AND a screenshot was provided) and absent
 * otherwise - including when vision is enabled but no screenshot came in
 * on this particular request, which must not break the text-only path.
 */
function baseRequest(overrides: Partial<SanitizedRequestValidated> = {}): SanitizedRequestValidated {
  return {
    schemaVersion: "1.0",
    requestId: "req_1",
    userIntent: "open the report",
    screen: {
      pageType: "dashboard",
      elements: [{ id: "btn_1", role: "button", label: "Report", interactive: true, redacted: false }],
    },
    privacy: { sanitized: true, findings: 0, redacted: 0, blocked: 0 },
    privacyPolicyVersion: "1.0",
    ...overrides,
  } as SanitizedRequestValidated;
}

function mockFetchOnce(): { fetchMock: ReturnType<typeof vi.fn>; getBody: () => unknown } {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              requestId: "req_1",
              actions: [{ actionId: "a-1", type: "DONE", confidence: 0.9 }],
              rationale: "test",
              confidence: 0.9,
            }),
          },
        },
      ],
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    getBody: () => JSON.parse(fetchMock.mock.calls[0]![1]!.body as string),
  };
}

describe("OpenAiCompatibleProvider - VLM (image) channel wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes an image_url content block when vision is enabled AND a screenshot is present", async () => {
    const { fetchMock, getBody } = mockFetchOnce();
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://fake-llm.example/v1",
      model: "test-model",
      apiKey: "test-key",
      visionEnabled: true,
    });

    const request = baseRequest({
      screen: {
        pageType: "dashboard",
        elements: [{ id: "btn_1", role: "button", label: "Report", interactive: true, redacted: false }],
        redactedScreenshot: { dataUrl: "data:image/jpeg;base64,AAAA", width: 480, height: 300 },
      },
    });

    await provider.generatePlan(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = getBody() as { messages: Array<{ role: string; content: unknown }> };
    const userMessage = body.messages.find((m) => m.role === "user")!;
    expect(Array.isArray(userMessage.content)).toBe(true);
    const content = userMessage.content as Array<{ type: string; image_url?: { url: string } }>;
    const imageBlock = content.find((c) => c.type === "image_url");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.image_url!.url).toBe("data:image/jpeg;base64,AAAA");

    // The raw screenshot data must NOT also be duplicated inside the text
    // JSON block - only width/height metadata.
    const textBlock = content.find((c) => c.type === "text") as { type: string; text: string };
    expect(textBlock.text).not.toContain("base64,AAAA");
    expect(textBlock.text).toContain("screenshotAttached");
  });

  it("does NOT include an image block when vision is disabled, even if a screenshot is present (text-only, unchanged behavior)", async () => {
    const { getBody } = mockFetchOnce();
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://fake-llm.example/v1",
      model: "test-model",
      apiKey: "test-key",
      visionEnabled: false, // the default
    });

    const request = baseRequest({
      screen: {
        pageType: "dashboard",
        elements: [{ id: "btn_1", role: "button", label: "Report", interactive: true, redacted: false }],
        redactedScreenshot: { dataUrl: "data:image/jpeg;base64,AAAA", width: 480, height: 300 },
      },
    });

    await provider.generatePlan(request);

    const body = getBody() as { messages: Array<{ role: string; content: unknown }> };
    const userMessage = body.messages.find((m) => m.role === "user")!;
    expect(typeof userMessage.content).toBe("string"); // plain text, exactly like before this feature existed
  });

  it("does NOT include an image block when vision is enabled but no screenshot was provided on this request", async () => {
    const { getBody } = mockFetchOnce();
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://fake-llm.example/v1",
      model: "test-model",
      apiKey: "test-key",
      visionEnabled: true,
    });

    await provider.generatePlan(baseRequest()); // no redactedScreenshot field at all

    const body = getBody() as { messages: Array<{ role: string; content: unknown }> };
    const userMessage = body.messages.find((m) => m.role === "user")!;
    expect(typeof userMessage.content).toBe("string");
  });
});
