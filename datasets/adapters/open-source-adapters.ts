import type { BenchmarkSample, DatasetAdapter } from "./benchmark-sample.js";

/**
 * HONESTY NOTE: none of the three adapters below fetch or parse real
 * dataset files. Doing so correctly requires: (1) network access to
 * Hugging Face/GitHub dataset mirrors this environment doesn't have
 * during development, (2) checking each dataset's actual license terms
 * before redistributing any of it (spec section 43), and (3) writing a
 * real parser against each dataset's native format (Mind2Web's action
 * traces, ScreenSpot's click-target JSON, VisualWebArena's task configs).
 * Faking their output would violate the "do not fabricate benchmark
 * values" rule directly. These classes exist so the `DatasetAdapter`
 * interface boundary is visible and so a real implementation can be
 * dropped in later without changing anything that consumes
 * `BenchmarkSample[]` - see docs/DATASET.md for what a real
 * implementation of each would need to do.
 */

export class ScreenSpotAdapter implements DatasetAdapter {
  readonly datasetName = "screenspot";

  async load(): Promise<BenchmarkSample[]> {
    throw new Error(
      "NOT_IMPLEMENTED: ScreenSpotAdapter requires downloading and licensing-checking the ScreenSpot/ScreenSpot-Pro dataset. See docs/DATASET.md."
    );
  }
}

export class Mind2WebAdapter implements DatasetAdapter {
  readonly datasetName = "mind2web";

  async load(): Promise<BenchmarkSample[]> {
    throw new Error(
      "NOT_IMPLEMENTED: Mind2WebAdapter requires downloading and parsing the Mind2Web action-trace dataset. See docs/DATASET.md."
    );
  }
}

export class VisualWebArenaAdapter implements DatasetAdapter {
  readonly datasetName = "visualwebarena";

  async load(): Promise<BenchmarkSample[]> {
    throw new Error(
      "NOT_IMPLEMENTED: VisualWebArenaAdapter requires the VisualWebArena task suite and its evaluation harness. See docs/DATASET.md."
    );
  }
}
