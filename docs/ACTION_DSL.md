# Action DSL

Defined in `packages/action-dsl/src/index.ts` as a Zod discriminated union.
This is the **only** vocabulary the server can use to affect the browser:

```ts
type Action =
  | { actionId: string; type: "CLICK"; targetId: string; confidence: number; reason?: string }
  | { actionId: string; type: "FOCUS"; targetId: string; confidence: number; reason?: string }
  | { actionId: string; type: "SCROLL"; direction: "UP" | "DOWN"; amount: number; confidence: number; reason?: string }
  | { actionId: string; type: "TYPE"; targetId: string; valueToken: string; confidence: number; reason?: string }
  | { actionId: string; type: "SELECT"; targetId: string; option: string; confidence: number; reason?: string }
  | { actionId: string; type: "NAVIGATE"; targetId: string; confidence: number; reason?: string }
  | { actionId: string; type: "WAIT"; milliseconds: number; confidence: number; reason?: string }
  | { actionId: string; type: "EXTRACT"; targetId: string; confidence: number; reason?: string }
  | { actionId: string; type: "DONE"; confidence: number; reason?: string }
  | { actionId: string; type: "REQUEST_CONFIRMATION"; targetId: string; message: string; confidence: number; reason?: string };
```

- `valueToken` (e.g. `"EMAIL_1"`) always points into the **local** privacy
  vault. The server proposes `TYPE { targetId: "email_input", valueToken:
  "EMAIL_1" }`; the client resolves `EMAIL_1` to the real email and types
  it, all locally. The server never sees the resolved value.
- `NAVIGATE` targets a `targetId` — a link element already present in the
  trusted DOM — rather than accepting an arbitrary URL string from the
  server. The client resolves the `href` from that element itself; the
  server cannot cause navigation to a URL of its own choosing.
- There is no action type for running a script, string, or arbitrary DOM
  selector query. `ActionSchema.safeParse` rejects anything else,
  including a plausible-looking `{"type": "EXECUTE_JAVASCRIPT", ...}`
  injection attempt — see `tests/unit/action-dsl.test.ts`.

## Five-tier risk classification

`classifyActionRisk()` in `packages/action-dsl/src/index.ts`:

| Action | Risk |
|---|---|
| `SCROLL`, `FOCUS`, `WAIT`, `EXTRACT`, `REQUEST_CONFIRMATION`, `DONE` | SAFE |
| `CLICK` / `SELECT` on an ordinary label | LOW |
| `TYPE` | MEDIUM |
| `NAVIGATE`, or `CLICK`/`SELECT` on a label matching a high-risk hint (submit, send, delete, purchase, payment, acknowledge, ...) | HIGH |
| `CLICK`/`SELECT` on a label matching a critical hint (payment authorization, credential, buy) | CRITICAL |

`isHighRisk()` returns true for HIGH and CRITICAL. Any action at HIGH or
above, or below the auto-confidence threshold, requires explicit user
confirmation before it executes — see `docs/SECURITY.md`.

## Confidence thresholds

| Confidence | Behavior |
|---|---|
| ≥ 0.90 | Execute automatically (if also not HIGH/CRITICAL risk) |
| 0.70 – 0.90 | Require user confirmation |
| < 0.70 | Reject outright, don't execute |

Thresholds are configurable via `validateActionStructurally`'s second
argument (`{ auto, verify }`).
