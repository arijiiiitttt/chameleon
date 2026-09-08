/**
 * Maintains a live mapping from stable local element ids
 * (data-chameleon-id) back to actual DOM nodes, so the executor can
 * resolve a server-referenced elementId at click/type time without
 * re-querying the whole document. Invalidated on significant DOM mutation
 * (see dom-observer.ts).
 */
export class ElementRegistry {
  private byId = new Map<string, WeakRef<HTMLElement>>();

  register(id: string, el: HTMLElement): void {
    this.byId.set(id, new WeakRef(el));
  }

  resolve(id: string): HTMLElement | null {
    const ref = this.byId.get(id);
    const el = ref?.deref();
    if (!el || !el.isConnected) {
      this.byId.delete(id);
      return null;
    }
    return el;
  }

  clear(): void {
    this.byId.clear();
  }

  rebuildFromDocument(doc: Document): void {
    this.clear();
    doc.querySelectorAll<HTMLElement>("[data-chameleon-id]").forEach((el) => {
      const id = el.getAttribute("data-chameleon-id");
      if (id) this.register(id, el);
    });
  }
}
