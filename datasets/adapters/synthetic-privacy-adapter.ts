import type { BenchmarkSample, DatasetAdapter, PiiAnnotation } from "./benchmark-sample.js";
import { generateAllSyntheticPages } from "../../benchmark/synthetic-pages.js";

/**
 * The one dataset adapter that is fully real in this repository: it wraps
 * `benchmark/synthetic-pages.ts` (mission-control, login-form, banking
 * pages with exact ground-truth PII placements) into the shared
 * `BenchmarkSample` schema. This is Layer 5 of the dataset strategy -
 * "controlled PII ground truth" - and is what `npm run benchmark`
 * actually exercises.
 */
export class SyntheticPrivacyAdapter implements DatasetAdapter {
  readonly datasetName = "synthetic-privacy";

  async load(): Promise<BenchmarkSample[]> {
    const pages = generateAllSyntheticPages();

    return pages.map((page) => {
      const piiAnnotations: PiiAnnotation[] = page.groundTruth.map((gt) => ({
        type: gt.category,
      }));

      return {
        id: page.id,
        datasetName: this.datasetName,
        task: `Detect and redact all sensitive information on the "${page.id}" page.`,
        domSnapshot: page.html,
        expectedActions: [],
        piiAnnotations,
        redactionAnnotations: [],
      };
    });
  }
}
