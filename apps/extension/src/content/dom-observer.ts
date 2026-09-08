export interface ChangeSignal {
  mutationCount: number;
  layoutChanged: boolean;
  urlChanged: boolean;
}

/**
 * Lightweight change detector. Counts DOM mutations via MutationObserver
 * and compares the current URL against the last observed value. Full
 * perception (OCR/vision/fusion) is only triggered when this reports a
 * signal above the configured thresholds - this is what keeps client
 * resource utilization low (spec section 34).
 */
export class DomChangeObserver {
  private observer: MutationObserver | null = null;
  private mutationCount = 0;
  private lastUrl = "";

  start(doc: Document, onChange: (signal: ChangeSignal) => void, debounceMs = 250): void {
    this.lastUrl = doc.location?.href ?? "";
    let timer: ReturnType<typeof setTimeout> | null = null;

    this.observer = new MutationObserver((mutations) => {
      this.mutationCount += mutations.length;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const urlChanged = doc.location?.href !== this.lastUrl;
        this.lastUrl = doc.location?.href ?? this.lastUrl;
        onChange({
          mutationCount: this.mutationCount,
          layoutChanged: this.mutationCount > 5,
          urlChanged,
        });
        this.mutationCount = 0;
      }, debounceMs);
    });

    this.observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  static shouldRunFullPerception(signal: ChangeSignal): boolean {
    return signal.urlChanged || signal.layoutChanged || signal.mutationCount > 10;
  }
}
