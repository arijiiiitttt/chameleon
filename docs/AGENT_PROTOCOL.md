# Agent Protocol

## States

```
IDLE -> OBSERVING -> PERCEIVING -> CLASSIFYING_PRIVACY -> SANITIZING
  -> FIREWALL_CHECK -> WAITING_FOR_SERVER -> PLANNING -> VALIDATING_ACTION
  -> [AWAITING_CONFIRMATION] -> EXECUTING -> VERIFYING -> OBSERVING (loop)
                                                        -> COMPLETED
Any stage -> FAILED (on error) or BLOCKED (firewall/validator rejection)
```

Defined as an explicit allow-list in
`apps/extension/src/agent/state-machine.ts` — `transition()` throws
`InvalidTransitionError` for anything not in the list. This is not
decorative: a missing transition (`OBSERVING -> CLASSIFYING_PRIVACY`
without an intermediate `PERCEIVING`) was caught by the test suite during
development (see LIMITATIONS.md §16) and required fixing the loop's actual
transition sequence, not just the allow-list.

## Loop guarantees

`apps/extension/src/agent/agent-loop.ts`, backed by `TaskManager`
(`apps/extension/src/agent/task-manager.ts`):

- Hard `maxIterations` (default 15) and `timeoutMs` (default 60s) —
  `tests/integration/agent-loop.test.ts` verifies a scenario that would
  otherwise loop forever correctly stops at the iteration cap.
- Cancellable via `TaskManager.cancel()`.
- A firewall rejection transitions straight to `BLOCKED` **before** the
  server is ever called — verified by asserting `serverCalled === false`
  in the same test file.
- Any thrown error during `sanitize()` also transitions to `BLOCKED`
  (fail-closed), not `FAILED` — a privacy-pipeline crash must never be
  treated as "safe to proceed without privacy checks."

## Dependency injection

The loop takes an `AgentLoopDeps` object (`perceive`, `sanitize`,
`callServer`, `execute`, `requestConfirmation`) rather than reaching for
global browser APIs directly. This is what makes the control flow
unit-testable without a browser, a network, or a real model — and it's
also the seam where `content-script.ts` plugs in the real DOM-backed
implementations for the actual extension.
