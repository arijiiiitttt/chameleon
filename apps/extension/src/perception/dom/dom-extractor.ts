import type { ScreenElement } from "@chameleon/shared-types";
import type { DomSignal } from "../../privacy/detectors/dom-detector.js";

const INTERACTIVE_SELECTOR =
  "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='tab'], [contenteditable='true']";

const CONTENT_SELECTOR =
  "h1, h2, h3, h4, h5, h6, p, span, label, td, th, li, img, table, dialog, [role='dialog'], [role='menu']";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function toRole(el: Element): string {
  const explicitRole = el.getAttribute("role");
  if (explicitRole) return explicitRole;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return (el as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "table") return "table";
  if (tag === "img") return "image";
  return tag;
}

function isVisible(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true; // jsdom without full layout support - assume visible for extraction purposes
  return style.display !== "none" && style.visibility !== "hidden";
}

function isEnabled(el: Element): boolean {
  return !(el as HTMLInputElement).disabled;
}

function stableAttrId(el: Element, generated: string): string {
  const existing = el.getAttribute("data-chameleon-id");
  if (existing) return existing;
  el.setAttribute("data-chameleon-id", generated);
  return generated;
}

export interface DomExtractionResult {
  elements: ScreenElement[];
  domSignals: DomSignal[];
}

/**
 * Walks the document extracting interactive and content elements. Runs
 * entirely locally; nothing here is transmitted until it passes the
 * privacy pipeline and firewall.
 */
export function extractDomElements(doc: Document): DomExtractionResult {
  const elements: ScreenElement[] = [];
  const domSignals: DomSignal[] = [];
  const seen = new Set<Element>();

  function pushElement(el: Element, interactive: boolean) {
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect
      ? el.getBoundingClientRect()
      : { x: 0, y: 0, width: 0, height: 0 };

    const generated = nextId(interactive ? "el" : "txt");
    const id = stableAttrId(el, generated);

    const text = (el.textContent ?? "").trim().slice(0, 300) || undefined;
    const ariaLabel = el.getAttribute("aria-label") ?? undefined;
    const inputType = el.tagName === "INPUT" ? (el as HTMLInputElement).type : undefined;

    elements.push({
      id,
      role: toRole(el),
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      text,
      ariaLabel,
      inputType,
      visible: isVisible(el),
      enabled: isEnabled(el),
      interactive,
      confidence: 1.0, // DOM-derived elements are ground truth, not visually inferred
    });

    if (interactive) {
      domSignals.push({
        elementId: id,
        inputType,
        autocomplete: el.getAttribute("autocomplete") ?? undefined,
        name: el.getAttribute("name") ?? undefined,
        ariaLabel,
        placeholder: el.getAttribute("placeholder") ?? undefined,
      });
    }
  }

  doc.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => pushElement(el, true));
  doc.querySelectorAll(CONTENT_SELECTOR).forEach((el) => pushElement(el, false));

  return { elements, domSignals };
}
