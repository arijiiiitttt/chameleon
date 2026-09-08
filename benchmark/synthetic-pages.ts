import type { SensitivityType } from "@chameleon/shared-types";

export interface SyntheticPage {
  id: string;
  html: string;
  groundTruth: Array<{ id: string; category: SensitivityType; rawValue: string }>;
}

let gtCounter = 0;
function gtId(): string {
  gtCounter += 1;
  return `gt_${gtCounter}`;
}

/** Mission-control style dashboard with embedded operator PII (spec section 41). */
export function generateMissionControlPage(): SyntheticPage {
  const groundTruth: SyntheticPage["groundTruth"] = [
    { id: gtId(), category: "PERSON", rawValue: "John Doe" },
    { id: gtId(), category: "EMAIL", rawValue: "john@example.com" },
    { id: gtId(), category: "PHONE", rawValue: "+919876543210" },
  ];

  const html = `
    <html><body>
      <h1>Mission Control</h1>
      <p>Mission: ORBIT-X</p>
      <p>Status: NOMINAL</p>
      <p>Temperature: 42C</p>
      <p>Power: 87%</p>
      <p>Operator: ${groundTruth[0]!.rawValue}</p>
      <p>Email: ${groundTruth[1]!.rawValue}</p>
      <p>Phone: ${groundTruth[2]!.rawValue}</p>
      <button>Telemetry</button>
      <button>Payload</button>
    </body></html>`;

  return { id: "mission_control", html, groundTruth };
}

/** Login form with a password and email field (spec section 43). */
export function generateLoginPage(): SyntheticPage {
  const groundTruth: SyntheticPage["groundTruth"] = [
    { id: gtId(), category: "EMAIL", rawValue: "jane@example.com" },
    { id: gtId(), category: "PASSWORD", rawValue: "SuperSecret123!" },
  ];

  const html = `
    <html><body>
      <form>
        <input type="email" name="email" autocomplete="email" value="${groundTruth[0]!.rawValue}" />
        <input type="password" name="password" autocomplete="current-password" value="${groundTruth[1]!.rawValue}" />
        <button type="submit">Login</button>
      </form>
    </body></html>`;

  return { id: "login_form", html, groundTruth };
}

/** Banking-style page with financial identifiers (spec section 45: "banking"). */
export function generateBankingPage(): SyntheticPage {
  const groundTruth: SyntheticPage["groundTruth"] = [
    { id: gtId(), category: "CREDIT_CARD", rawValue: "4111 1111 1111 1111" },
    { id: gtId(), category: "IDENTIFIER", rawValue: "1234 5678 9012" },
    { id: gtId(), category: "ADDRESS", rawValue: "221B Baker Street" },
  ];

  const html = `
    <html><body>
      <h1>Account Summary</h1>
      <p>Card Number: ${groundTruth[0]!.rawValue}</p>
      <p>Aadhaar: ${groundTruth[1]!.rawValue}</p>
      <p>Address: ${groundTruth[2]!.rawValue}</p>
      <p>Balance: 45,000</p>
      <button>Transfer</button>
      <button>Statements</button>
    </body></html>`;

  return { id: "banking", html, groundTruth };
}

export function generateAllSyntheticPages(): SyntheticPage[] {
  return [generateMissionControlPage(), generateLoginPage(), generateBankingPage()];
}
