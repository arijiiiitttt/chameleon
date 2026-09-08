import { createApp } from "../src/app.js";

async function main() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  console.log("=== 1. Health check ===");
  const health = await fetch(`${base}/health`).then((r) => r.json());
  console.log(health);

  console.log("\n=== 2. Mission-control demo: 'Open the detailed telemetry report' ===");
  const sanitizedRequest = {
    schemaVersion: "1.0",
    requestId: "req_demo_1",
    userIntent: "Open the detailed telemetry report",
    screen: {
      pageType: "mission_dashboard",
      elements: [
        { id: "btn_telemetry", role: "button", label: "Telemetry", interactive: true, redacted: false },
        { id: "btn_payload", role: "button", label: "Payload", interactive: true, redacted: false },
        { id: "operator", role: "text", label: "[PERSON_1]", interactive: false, redacted: true },
        { id: "email", role: "text", label: "[EMAIL_1]", interactive: false, redacted: true },
        { id: "temperature", role: "text", label: "Temperature", value: "42\u00b0C", interactive: false, redacted: false },
      ],
    },
    privacy: { sanitized: true, findings: 4, redacted: 4, blocked: 0 },
    privacyPolicyVersion: "1.0",
  };

  const planResponse = await fetch(`${base}/api/v1/reason`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sanitizedRequest),
  });
  console.log("status:", planResponse.status);
  console.log(await planResponse.json());

  console.log("\n=== 3. Scroll-intent demo ===");
  const scrollRequest = { ...sanitizedRequest, requestId: "req_demo_2", userIntent: "scroll down to the power subsystem" };
  const scrollPlanResponse = await fetch(`${base}/api/v1/reason`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scrollRequest),
  });
  console.log("status:", scrollPlanResponse.status);
  console.log(await scrollPlanResponse.json());

  console.log("\n=== 4. Reject a payload where raw PII slipped past the client (server-side sanity check) ===");
  const leakyRequest = {
    ...sanitizedRequest,
    requestId: "req_demo_3",
    userIntent: "email me at john@example.com about telemetry", // raw email embedded in an otherwise-sanitized request
  };
  const leakyResponse = await fetch(`${base}/api/v1/reason`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(leakyRequest),
  });
  console.log("status:", leakyResponse.status);
  console.log(await leakyResponse.json());

  console.log("\n=== 5. Reject a malformed / schema-invalid payload ===");
  const malformedResponse = await fetch(`${base}/api/v1/reason`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonsense: true }),
  });
  console.log("status:", malformedResponse.status);
  console.log(await malformedResponse.json());

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
