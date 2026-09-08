/**
 * Runs CHAMELEON's real regex detector against a genuine, EXTERNALLY
 * AUTHORED, MIT-licensed labeled dataset: Microsoft Presidio's own
 * `context_sentences_tests.txt` fixture
 * (datasets/external/presidio_context_sentences.txt, copied verbatim
 * from https://github.com/microsoft/presidio, license copy alongside
 * it at datasets/external/PRESIDIO_LICENSE.txt).
 *
 * This exists specifically to answer a question the repo's own
 * synthetic-page benchmark (benchmark/run-benchmark.ts) cannot: how
 * does detection perform on text nobody on this project wrote,
 * formatted the way an unrelated team chose to format it? The synthetic
 * pages are still useful (they cover categories this file doesn't, like
 * EMAIL/PASSWORD/CREDIT_CARD/PERSON/ADDRESS), but "we tested it against
 * our own test data" and "we tested it against someone else's test
 * data" are different, complementary claims - this script produces the
 * second one, honestly scoped to only the categories this dataset
 * actually contains.
 *
 * Format of the source file: alternating lines of
 *   ENTITY_TYPE
 *   a sentence containing that entity
 * with blank-line separators and '#'-prefixed comments, parsed below.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectRegexSensitivity } from "../apps/extension/src/privacy/detectors/regex-detector.js";
import type { SensitivityType } from "@chameleon/shared-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = path.join(__dirname, "../datasets/external/presidio_context_sentences.txt");

/**
 * Maps Presidio's entity type vocabulary onto CHAMELEON's own
 * SensitivityType taxonomy, where a genuine conceptual match exists.
 * Entity types with no real CHAMELEON equivalent (region-specific
 * government ID formats CHAMELEON's regex set was never built to
 * recognize, e.g. Philippines TIN, ABA routing numbers) are left
 * unmapped and EXCLUDED from scoring - scoring against a category the
 * system never claimed to detect would be a meaningless number, not a
 * conservative one.
 */
const ENTITY_TYPE_MAP: Partial<Record<string, SensitivityType>> = {
  PHONE_NUMBER: "PHONE",
  IP_ADDRESS: "OTHER", // covered by CHAMELEON's generic URL/IP pattern
  US_SSN: "IDENTIFIER",
  US_ITIN: "IDENTIFIER",
  IN_PAN: "IDENTIFIER", // Indian PAN - the same category CHAMELEON's own Aadhaar/PAN-like pattern targets
};

interface LabeledExample {
  entityType: string;
  sentence: string;
  mappedCategory: SensitivityType | null;
}

function parseDataset(raw: string): LabeledExample[] {
  const lines = raw.split("\n").map((l) => l.trim());
  const examples: LabeledExample[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line || line.startsWith("#")) continue;
    if (/^[A-Z_]+$/.test(line)) {
      const sentence = lines[i + 1];
      if (sentence && sentence.length > 0) {
        examples.push({
          entityType: line,
          sentence,
          mappedCategory: ENTITY_TYPE_MAP[line] ?? null,
        });
        i += 1;
      }
    }
  }
  return examples;
}

function main(): void {
  const raw = readFileSync(DATASET_PATH, "utf-8");
  const all = parseDataset(raw);
  const scored = all.filter((e) => e.mappedCategory !== null);
  const skipped = all.filter((e) => e.mappedCategory === null);

  console.log(`Loaded ${all.length} real, externally-authored labeled examples from Presidio's test fixture.`);
  console.log(
    `${scored.length} fall into a category CHAMELEON's detectors claim to cover; ${skipped.length} do not (unmapped entity types: ${[
      ...new Set(skipped.map((e) => e.entityType)),
    ].join(", ")}) and are excluded from scoring, not counted as failures.\n`
  );

  const perCategory = new Map<string, { tp: number; fn: number; examples: string[] }>();

  for (const example of scored) {
    const findings = detectRegexSensitivity([{ regionId: "r1", text: example.sentence, source: "DOM" }]);
    const hit = findings.some((f) => f.category === example.mappedCategory);

    const key = `${example.entityType} -> ${example.mappedCategory}`;
    const bucket = perCategory.get(key) ?? { tp: 0, fn: 0, examples: [] };
    if (hit) {
      bucket.tp += 1;
    } else {
      bucket.fn += 1;
      bucket.examples.push(example.sentence);
    }
    perCategory.set(key, bucket);
  }

  console.log("Category (Presidio entity -> CHAMELEON category)   TP   FN   Recall");
  console.log("--------------------------------------------------------------------");
  let totalTp = 0;
  let totalFn = 0;
  for (const [key, { tp, fn, examples }] of [...perCategory.entries()].sort()) {
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    console.log(`${key.padEnd(48)} ${String(tp).padStart(3)}  ${String(fn).padStart(3)}   ${recall.toFixed(2)}`);
    if (examples.length > 0) {
      console.log(`  missed: ${examples.map((s) => JSON.stringify(s)).join("; ")}`);
    }
    totalTp += tp;
    totalFn += fn;
  }
  const overallRecall = totalTp + totalFn > 0 ? totalTp / (totalTp + totalFn) : 0;
  console.log("--------------------------------------------------------------------");
  console.log(`OVERALL (external dataset, mapped categories only): TP=${totalTp} FN=${totalFn} Recall=${overallRecall.toFixed(2)}`);
  console.log(
    "\nNote: this measures RECALL only (does the detector fire on real, externally-\n" +
      "authored sentences it should fire on). It does not measure PRECISION against\n" +
      "this dataset because the file contains no negative (PII-free) examples to\n" +
      "compute false positives against - precision numbers remain those from\n" +
      "benchmark/run-benchmark.ts's synthetic pages (see docs/EVALUATION.md)."
  );
}

main();
