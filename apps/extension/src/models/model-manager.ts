export interface ModelHandle {
  id: string;
  backend: "webgpu" | "wasm" | "cpu" | "unavailable";
  loadedAt: number;
}

export interface ModelDefinition {
  id: string;
  load: () => Promise<unknown>;
  warmup?: (instance: unknown) => Promise<void>;
  infer: (instance: unknown, input: unknown) => Promise<unknown>;
  dispose?: (instance: unknown) => Promise<void>;
}

/**
 * Central registry preventing the "re-initialize per frame" anti-pattern
 * called out in spec section 10. Models are loaded once, cached, and
 * reused across perception cycles until explicitly unloaded.
 */
export class ModelManager {
  private definitions = new Map<string, ModelDefinition>();
  private instances = new Map<string, unknown>();
  private handles = new Map<string, ModelHandle>();
  private inflightLoads = new Map<string, Promise<void>>();

  register(definition: ModelDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  async load(modelId: string): Promise<void> {
    if (this.instances.has(modelId)) return; // already loaded - no-op
    const existing = this.inflightLoads.get(modelId);
    if (existing) return existing; // de-dupe concurrent load calls

    const def = this.definitions.get(modelId);
    if (!def) throw new Error(`MODEL_INITIALIZATION_FAILED: unknown model "${modelId}"`);

    const loadPromise = (async () => {
      const instance = await def.load();
      this.instances.set(modelId, instance);
      this.handles.set(modelId, { id: modelId, backend: "unavailable", loadedAt: Date.now() });
    })();

    this.inflightLoads.set(modelId, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.inflightLoads.delete(modelId);
    }
  }

  async warmup(modelId: string): Promise<void> {
    const def = this.definitions.get(modelId);
    const instance = this.instances.get(modelId);
    if (!def || instance === undefined) throw new Error("MODEL_INITIALIZATION_FAILED");
    if (def.warmup) await def.warmup(instance);
  }

  async infer(modelId: string, input: unknown): Promise<unknown> {
    const def = this.definitions.get(modelId);
    const instance = this.instances.get(modelId);
    if (!def || instance === undefined) {
      throw new Error("MODEL_INITIALIZATION_FAILED");
    }
    return def.infer(instance, input);
  }

  async unload(modelId: string): Promise<void> {
    const def = this.definitions.get(modelId);
    const instance = this.instances.get(modelId);
    if (def?.dispose && instance !== undefined) {
      await def.dispose(instance);
    }
    this.instances.delete(modelId);
    this.handles.delete(modelId);
  }

  getHandle(modelId: string): ModelHandle | undefined {
    return this.handles.get(modelId);
  }

  isLoaded(modelId: string): boolean {
    return this.instances.has(modelId);
  }
}
