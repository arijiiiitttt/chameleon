# Security

## The privacy firewall

`firewall/outbound-firewall.ts` is called on **every** payload the agent
loop is about to send to the server. It:

1. Recursively scans the payload (`firewall/payload-scanner.ts`) for
   patterns matching email, phone, credit-card-like sequences, and
   Aadhaar-like identifiers, and for suspiciously-named fields
   (`password`, `rawEmail`, `cardNumber`, ...) holding a non-empty string —
   catching leaks that wouldn't match a content pattern.
2. Flags any field whose *name* looks like a raw screenshot
   (`firewall/leakage-detector.ts`), independent of its content - with
   one exact, narrow exception: a field named precisely
   `redactedScreenshot` is permitted, because the only code path that
   populates it (`content-script.ts`) is required to run
   `applyImageRedaction()` against the privacy pipeline's own
   `imageRedactionRegions` first. Any other screenshot-shaped field name,
   including near-misses, is still blocked - see
   `tests/security/leakage.test.ts`.
3. **Fails closed**: if the scan itself throws, the firewall returns
   `allowed: false` rather than defaulting to allow.

The exact leakage test from the spec — attempting to send
`{"message": "Send user email: john@example.com"}` — is a real, running
test: `tests/security/leakage.test.ts`. Run `npm run test:privacy` to
execute it (and the rest of the security suite) in isolation.

The agent loop (`agent/agent-loop.ts`) calls the firewall immediately after
sanitization and transitions to the `BLOCKED` state — never calling the
server — if it's rejected. This is covered by
`tests/integration/agent-loop.test.ts`.

## Server-side defense in depth

Even though the client firewall is the primary control, the server
independently re-validates:

- **Schema validation** (`packages/protocol`, Zod) — malformed payloads are
  rejected with `400 SCHEMA_VALIDATION_FAILED`.
- **Sanity re-scan** (`serverSideSanityScan`) — a coarse, independent
  pattern match over the *entire* received payload. A payload that
  somehow claims `privacy.sanitized: true` but still contains a raw email
  is rejected with `400 SERVER_SANITY_CHECK_FAILED` (see
  `tests/integration/server.test.ts`).
- **Action-plan re-validation** (`apps/server/src/planner/planner.ts`) — the
  reasoning provider's output is re-parsed against the same `ActionPlanSchema`
  regardless of what the provider claims to have returned.

## Restricted Action DSL

The server can only ever produce one of six typed actions
(`CLICK/SCROLL/TYPE/SELECT/NAVIGATE/WAIT`) — see `docs/ACTION_DSL.md`.
There is no `eval`, `new Function`, or "run this script" variant anywhere
in the schema, and `apps/server/src/providers/openai-compatible.ts`'s
system prompt explicitly tells the model that screen content is untrusted
UI data, not instructions (defense against the injection scenario in
the classic "Ignore previous instructions..." injection pattern).

## Local action validation

`executor/action-validator.ts` re-checks every action against the **live**
`ScreenState`, not the one the server reasoned about:

- Structural + confidence validation (via `packages/action-dsl`)
- Element existence, visibility, enabled, and interactive checks
- Screen-id match (rejects `STALE_SCREEN` if the page changed since the
  server's plan was generated)
- High-risk actions (submit/delete/send/payment-like labels, or any
  `NAVIGATE`) and low-confidence actions (< 0.9) require explicit user
  confirmation before executing

## Extension permissions

The Chrome manifest (`manifest.chrome.json`) requests only:

- `activeTab` — required to capture/read the current tab on user action
- `scripting` — required to execute the typed Action DSL in the page
- `storage` — required for the local privacy vault and policy settings

No `<all_urls>` host permission is requested; content scripts run at
`document_idle` on pages the user is already viewing via `activeTab`.

## Core security invariants

These are asserted throughout the test suite, not just claimed in prose:

1. Raw PII never exists in an outbound payload — `tests/security/leakage.test.ts`
2. Raw screenshots are never sent unredacted — the firewall flags any
   screenshot-shaped field, with one exact exception (`redactedScreenshot`)
   that can only ever contain client-side, already pixel-redacted image
   data — see `docs/LIMITATIONS.md` §3c
3. Passwords are never transmitted — default policy is `BLOCK`
4. The vault never leaves the client — no code path serializes vault
   contents into a network-bound object
5. The server cannot execute arbitrary JS — the Action DSL has no such
   variant, and content-script execution only runs `applyActionInPage`
   with a typed `Action` argument
6. Every server action passes local validation before execution —
   `tests/integration/agent-loop.test.ts`
7. A privacy-pipeline failure blocks transmission (fail-closed) —
   asserted in the agent loop's `BLOCKED` transition on a `sanitize()` throw
8. High-risk actions require user confirmation — `tests/unit/action-dsl.test.ts`
