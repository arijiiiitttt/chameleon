import type { BoundingBox, SensitivityType } from "@chameleon/shared-types";

/**
 * HONESTY NOTE (see docs/LIMITATIONS.md): this file defines the *shape*
 * datasets are normalized into and the *interface* adapters implement.
 * It does not ship any actual ScreenSpot/Mind2Web/VisualWebArena data or
 * a downloader for it - those datasets are large, license-gated, and
 * require network access this environment doesn't have to Hugging
 * Face/GitHub dataset mirrors. What's real here: the schema, the
 * `SyntheticPrivacyAdapter` (backed by the same generator used by
 * `benchmark/run-benchmark.ts`), and the adapter interface that a real
 * Mind2Web/ScreenSpot integration would implement without requiring any
 * change to the evaluation engine that consumes `BenchmarkSample[]`.
 */

export interface PiiAnnotation {
  type: SensitivityType;
  bbox?: BoundingBox;
  textRange?: { start: number; end: number };
}

export interface RedactionAnnotation {
  bbox: BoundingBox;
  method: "black-box" | "blur" | "pixelation" | "semantic-replacement" | "region-removal";
}

export interface GroundTruthAction {
  type: string; // matches an Action DSL type, kept loose here since some source datasets predate the DSL
  targetDescription: string; // human-readable target description (accessible name, label, etc.)
  targetBbox?: BoundingBox;
}

export interface BenchmarkSample {
  id: string;
  /** which dataset this sample came from, e.g. "mind2web", "screenspot", "synthetic-privacy" */
  datasetName: string;
  task: string;
  /** path or URI to the screenshot, when the sample includes one - never embedded raw in this schema */
  screenshotRef?: string;
  domSnapshot?: string;
  accessibilitySnapshot?: string;
  ocrText?: string;
  targetElementDescription?: string;
  expectedActions: GroundTruthAction[];
  piiAnnotations: PiiAnnotation[];
  redactionAnnotations: RedactionAnnotation[];
  expectedState?: string;
}

/**
 * Every dataset adapter implements this interface. The evaluation engine
 * (packages/evaluation) only ever depends on `BenchmarkSample[]`, never on
 * a specific dataset's native format - this is what makes it possible to
 * plug in the eventual ISRO finale evaluation cases through the same
 * interface (spec section 79) without redesigning anything.
 */
export interface DatasetAdapter {
  readonly datasetName: string;
  load(): Promise<BenchmarkSample[]>;
}
