# Dataset Strategy

CHAMELEON uses a layered dataset strategy. Every layer is normalized into
the shared `BenchmarkSample` schema (`datasets/adapters/benchmark-sample.ts`)
via a `DatasetAdapter`, so the evaluation engine never depends on a
specific dataset's native format — this is what lets ISRO's eventual
finale evaluation cases be ingested through the same interface without
redesigning anything.

**Honest status of each layer**, from the manifest at
`datasets/manifests/dataset_manifest.json`:

| Layer | Dataset | Purpose | Status |
|---|---|---|---|
| 1 | ScreenSpot / ScreenSpot-Pro | GUI visual grounding, click-target accuracy | **Not implemented** — interface stub only |
| 2 | Mind2Web | Instruction following, DOM/action grounding | **Not implemented** — interface stub only |
| 3 | VisualWebArena | End-to-end multimodal web-agent evaluation | **Not implemented** — interface stub only |
| 4 | Online-Mind2Web | Broader live-web evaluation | **Not implemented** — interface stub only |
| 5 | Synthetic privacy dataset | Controlled PII/redaction ground truth | **Implemented and tested** |

## Why layers 1–4 are stubs, not fakes

Correctly integrating ScreenSpot, Mind2Web, or VisualWebArena requires:

1. Network access to download the actual dataset files (this development
   environment doesn't have access to the relevant Hugging Face/GitHub
   dataset mirrors).
2. Checking each dataset's actual license terms before any redistribution.
3. Writing a real parser against each dataset's native format — Mind2Web's
   action-trace JSON, ScreenSpot's click-target annotations,
   VisualWebArena's task configs — which differs for each.

`ScreenSpotAdapter`, `Mind2WebAdapter`, and `VisualWebArenaAdapter`
(`datasets/adapters/open-source-adapters.ts`) exist as concrete classes
implementing `DatasetAdapter`, but their `load()` method truthfully throws
`NOT_IMPLEMENTED` rather than returning fabricated `BenchmarkSample[]`
data. This is verified by `tests/unit/dataset-adapters.test.ts` — the test
suite asserts they throw, not that they "work."

**To make one of these real:** implement `load()` to fetch/parse the
dataset (respecting its license and any train/test-set restrictions per
`dataset_manifest.json`'s `policy` block) and map its native samples into
`BenchmarkSample`. No other code needs to change — `packages/evaluation`
and `benchmark/run-benchmark.ts` already consume the adapter interface,
not a specific dataset's shape.

## What is real: the synthetic privacy dataset

`datasets/adapters/synthetic-privacy-adapter.ts` wraps
`benchmark/synthetic-pages.ts` (the same generator `npm run benchmark`
uses) into `BenchmarkSample[]`, with exact ground-truth PII placements per
page. This is genuinely Layer 5 of the strategy — "controlled PII ground
truth" — and is what backs the PII precision/recall numbers reported in
`docs/EVALUATION.md`.

## Governance

`datasets/manifests/dataset_manifest.json` records, for every dataset
referenced anywhere in this codebase: name, version, license, source,
purpose, and implementation status. No dataset entry claims to be ISRO's
official evaluation set — the manifest's `policy` block states this
explicitly, and a test (`tests/unit/dataset-adapters.test.ts`) asserts no
such claim exists.

## Train/test discipline

The `policy.trainOnTestSetProhibited` flag in the manifest documents the
principle: CHAMELEON's goal is not to train a large model on these
benchmarks, but to build and evaluate a reliable on-device perception and
privacy architecture. No training pipeline exists in this repository —
only evaluation and benchmarking.
