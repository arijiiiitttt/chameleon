import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../apps/server/src/app.js";

describe("Server API", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = createApp();
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  const baseRequest = {
    schemaVersion: "1.0",
    requestId: "req_1",
    userIntent: "Open the detailed telemetry report",
    screen: {
      pageType: "mission_dashboard",
      elements: [{ id: "btn_telemetry", role: "button", label: "Telemetry", interactive: true, redacted: false }],
    },
    privacy: { sanitized: true, findings: 0, redacted: 0, blocked: 0 },
    privacyPolicyVersion: "1.0",
  };

  it("returns a CLICK action for a matching intent", async () => {
    const res = await fetch(`${base}/api/v1/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions[0].type).toBe("CLICK");
    expect(body.actions[0].targetId).toBe("btn_telemetry");
  });

  it("rejects a schema-invalid payload with 400", async () => {
    const res = await fetch(`${base}/api/v1/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a payload containing a raw email even if schemaVersion/privacy.sanitized claim it's clean", async () => {
    const res = await fetch(`${base}/api/v1/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseRequest, userIntent: "contact john@example.com" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("SERVER_SANITY_CHECK_FAILED");
  });

  it("accepts a request carrying a real redactedScreenshot field (large base64 payload) without a false-positive SERVER_SANITY_CHECK_FAILED", async () => {
    // Same false-positive risk as the client-side firewall test in
    // tests/security/leakage.test.ts, but exercised end-to-end over real
    // HTTP against the real server: a long, effectively-random base64
    // string will, by pure chance, very likely contain a coincidental
    // 10-19 digit run that would otherwise trip the server's own raw-PII
    // regex scan on every single screenshot-bearing request.
    const fakeBase64Pixels = Array.from({ length: 3000 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[Math.floor(Math.random() * 64)]
    ).join("");

    const requestWithScreenshot = {
      ...baseRequest,
      requestId: "req_vlm",
      screen: {
        ...baseRequest.screen,
        redactedScreenshot: {
          dataUrl: `data:image/jpeg;base64,${fakeBase64Pixels}`,
          width: 480,
          height: 300,
        },
      },
    };

    const res = await fetch(`${base}/api/v1/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestWithScreenshot),
    });
    expect(res.status).toBe(200);
  });

  it("still rejects a raw email hidden inside an otherwise-legitimate redactedScreenshot-bearing request", async () => {
    // Confirms the screenshot exemption is narrowly scoped to that one
    // field - a real PII leak anywhere ELSE in the same request must
    // still be caught.
    const requestWithLeak = {
      ...baseRequest,
      requestId: "req_vlm_leak",
      userIntent: "contact john@example.com",
      screen: {
        ...baseRequest.screen,
        redactedScreenshot: { dataUrl: "data:image/jpeg;base64,AAAA", width: 10, height: 10 },
      },
    };

    const res = await fetch(`${base}/api/v1/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestWithLeak),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("SERVER_SANITY_CHECK_FAILED");
  });

  it("health check reports the active AI provider", async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.aiProvider).toBe("mock");
  });

  it("CHAMELEON demo: 'Analyze satellite anomaly; acknowledge incident.' resolves to CLICK on the Acknowledge Incident button via domain-independent word-overlap matching (not a hardcoded page rule)", async () => {
    const missionControlRequest = {
      schemaVersion: "1.0",
      requestId: "req_demo",
      userIntent: "Analyze satellite anomaly; acknowledge incident.",
      screen: {
        pageType: "mission_control",
        elements: [
          { id: "view_diagnostics", role: "button", label: "View Diagnostics", interactive: true, redacted: false },
          { id: "acknowledge_42", role: "button", label: "Acknowledge Incident", interactive: true, redacted: false },
          { id: "operator", role: "text", label: "[PERSON_1]", interactive: false, redacted: true },
        ],
      },
      privacy: { sanitized: true, findings: 1, redacted: 1, blocked: 0 },
      privacyPolicyVersion: "1.0",
    };

    const res = await fetch(`${base}/api/v1/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(missionControlRequest),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions[0].type).toBe("CLICK");
    expect(body.actions[0].targetId).toBe("acknowledge_42"); // NOT view_diagnostics - word overlap correctly disambiguates
  });
});
