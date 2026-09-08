import type { BoundingBox, Viewport } from "./geometry.js";
import type { PrivacyFinding, SensitivityType } from "./privacy.js";

export interface ScreenElement {
  id: string;
  role: string;
  bbox: BoundingBox;
  text?: string;
  ariaLabel?: string;
  inputType?: string;
  visible: boolean;
  enabled: boolean;
  interactive: boolean;
  sensitivity?: SensitivityType;
  confidence: number;
}

export interface OCRRegion {
  id: string;
  text: string;
  bbox: BoundingBox;
  confidence: number;
}

export type VisualRegionKind =
  | "face"
  | "person"
  | "document"
  | "image"
  | "table"
  | "chart"
  | "button-like"
  | "input-like"
  | "sensitive-visual-region";

export interface VisualRegion {
  id: string;
  kind: VisualRegionKind;
  bbox: BoundingBox;
  confidence: number;
  /** which inference backend actually produced this region - never fabricated */
  backend: "webgpu" | "wasm" | "cpu" | "unavailable";
  /**
   * The `data-chameleon-id` of the source `<img>`/`<canvas>` DOM element
   * this region was derived from, when known - lets a whole-element
   * classification (e.g. scene classifier output) round-trip back to a
   * real, executor-resolvable DOM node so the reasoning server can target
   * it with an EXTRACT action, not just use it for redaction. Per-box
   * detections (e.g. individual face boxes) that don't correspond 1:1 to
   * a whole DOM element may omit this.
   */
  sourceElementId?: string;
}

export type ScreenRelationType =
  | "ABOVE"
  | "BELOW"
  | "LEFT_OF"
  | "RIGHT_OF"
  | "INSIDE"
  | "NEAR"
  | "ASSOCIATED_WITH";

export interface ScreenRelation {
  from: string;
  to: string;
  type: ScreenRelationType;
}

export interface PageMetadata {
  url: string;
  title: string;
  pageType?: string;
}

export interface ScreenState {
  id: string;
  timestamp: number;
  viewport: Viewport;
  page: PageMetadata;
  elements: ScreenElement[];
  visualRegions: VisualRegion[];
  ocrRegions: OCRRegion[];
  relations: ScreenRelation[];
  /** Findings attached after the privacy pipeline has run. Empty before privacy analysis. */
  privacyFindings: PrivacyFinding[];
  confidence: number;
}

export interface ScreenCapture {
  image: Blob | ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
}
