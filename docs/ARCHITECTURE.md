# Architecture

## Trust zones

**Zone A — PRIVATE (the user's browser).** Raw screenshots, raw DOM, raw
text, passwords, names, emails, phone numbers, faces, cookies, tokens.
Never leaves this zone.

**Zone B — SANITIZED.** The output of the privacy pipeline: tokens
(`[EMAIL_1]`), masks, public UI structure (button labels, roles), and
non-sensitive values (`Temperature: 42°C`). Only this may cross the
network boundary, and only after the firewall approves it.

**Zone C — SERVER.** Receives sanitized `ScreenState`, the user's intent,
and (optionally) a redacted screenshot. Runs the reasoning provider and
planner, and returns actions restricted to the Action DSL. Never receives
raw PII — enforced by (1) the client firewall before send and (2) an
independent server-side pattern scan on receipt.

## Data flow

```
Screen / DOM / ARIA
        |
        v
Local Perception (DOM extractor, ARIA extractor, OCR, vision, fusion)
        |
        v
Unified ScreenState
        |
        v
Privacy Detection (DOM, regex, NER, vision detectors -> classifier merge)
        |
        v
Privacy Policy Engine (risk-based ALLOW/MASK/BLUR/TOKENIZE/BLOCK)
        |
        v
Redaction / Tokenization (text + bbox + image redactors, local vault)
        |
        v
Outbound Privacy Firewall  <-- recursively scans the fully-built payload
        |  (SAFE DATA ONLY)
        v
HTTPS -> Server: schema validation -> sanity re-scan -> reasoning provider
        |
        v  (ACTION ONLY, from the restricted Action DSL)
Local Action Validator (re-checks against the LIVE screen, not the one
the server reasoned about, and requires confirmation for high-risk/
low-confidence actions)
        |
        v
Local Action Executor -> Browser -> new screen state -> Verification
        |
        +----------------------------> Agent Loop (re-observe)
```

## Module map (implemented in this repository)

| Concern | Package/module |
|---|---|
| Shared types (ScreenState, PrivacyFinding, geometry) | `packages/shared-types` |
| Restricted Action DSL + Zod validation | `packages/action-dsl` |
| Risk-based policy engine | `packages/privacy-policy` |
| DOM+OCR+vision fusion | `packages/screen-state` |
| Wire protocol schemas + server sanity scan | `packages/protocol` |
| Evaluation metrics (precision/recall/F1/IoU) | `packages/evaluation` |
| DOM/ARIA extraction | `apps/extension/src/perception/{dom,aria}` |
| OCR / vision model abstraction | `apps/extension/src/perception/ocr`, `apps/extension/src/models` |
| PII detectors (DOM, regex, NER) | `apps/extension/src/privacy/detectors` |
| Classifier (confidence-boosting merge) | `apps/extension/src/privacy/classifier` |
| Local privacy vault | `apps/extension/src/privacy/vault` |
| Redaction (text/bbox/image) | `apps/extension/src/redaction` |
| Outbound firewall + leakage detector | `apps/extension/src/firewall` |
| Agent state machine + loop | `apps/extension/src/agent` |
| Action validator + executor | `apps/extension/src/executor` |
| Browser adapter (Chrome/Firefox) | `apps/extension/src/utils/browser-adapter.ts` |
| Server API, schemas, providers, planner | `apps/server/src` |
| Server's inlined Action DSL + protocol schemas | `apps/server/src/shared` — see [DEPLOYMENT.md](DEPLOYMENT.md) for why `apps/server` doesn't use the `packages/action-dsl`/`packages/protocol` workspace packages |

## Architectural separation

React UI, ML/perception, privacy, network, agent logic, and raw browser
APIs are kept in separate modules communicating through typed interfaces
(`BrowserAdapter`, `LocalVisionModel`, `OcrService`, `ReasoningProvider`,
`AgentLoopDeps`). This is what allows the privacy pipeline, firewall,
action DSL, and agent loop to be unit- and integration-tested with mocked
dependencies, entirely without a browser — see `tests/`.
