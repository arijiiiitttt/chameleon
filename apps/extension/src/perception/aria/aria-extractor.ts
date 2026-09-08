export interface AriaSignal {
  elementId: string;
  role?: string;
  name?: string;
  description?: string;
  state?: {
    disabled?: boolean;
    checked?: boolean;
    expanded?: boolean;
    selected?: boolean;
  };
  value?: string;
}

/**
 * Reads ARIA attributes directly off each already-extracted DOM element.
 * Kept as a separate pass (rather than folded into dom-extractor.ts) so it
 * can evolve independently - e.g. to consult the browser's computed
 * accessibility tree via the (currently experimental) AOM APIs where
 * available, without touching DOM extraction.
 */
export function extractAriaSignals(doc: Document): AriaSignal[] {
  const signals: AriaSignal[] = [];
  const nodes = doc.querySelectorAll<HTMLElement>("[data-chameleon-id]");

  nodes.forEach((el) => {
    const elementId = el.getAttribute("data-chameleon-id");
    if (!elementId) return;

    signals.push({
      elementId,
      role: el.getAttribute("role") ?? undefined,
      name: el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") ?? undefined,
      description: el.getAttribute("aria-describedby") ?? undefined,
      state: {
        disabled: el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).disabled,
        checked: el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked,
        expanded: el.getAttribute("aria-expanded") === "true",
        selected: el.getAttribute("aria-selected") === "true",
      },
      value: (el as HTMLInputElement).value ?? undefined,
    });
  });

  return signals;
}

/**
 * Merges ARIA name/role into a lower-confidence visual-only guess, per the
 * spec-7 example: a rectangle detected visually + role=button + name from
 * ARIA together produce a confident unified element. Here we simply upgrade
 * an existing ScreenElement's role/label when ARIA data disagrees or adds
 * missing information; the caller applies this to the fused elements list.
 */
export function applyAriaToElement<T extends { role: string; ariaLabel?: string; confidence: number }>(
  element: T,
  aria: AriaSignal | undefined
): T {
  if (!aria) return element;
  return {
    ...element,
    role: aria.role ?? element.role,
    ariaLabel: aria.name ?? element.ariaLabel,
    confidence: Math.min(1, element.confidence + 0.05), // ARIA agreement slightly boosts confidence
  };
}
