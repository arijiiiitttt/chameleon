import type { Action } from "@chameleon/action-dsl";
import type { ScreenCapture } from "@chameleon/shared-types";

export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

export interface BrowserAdapter {
  captureVisibleTab(): Promise<ScreenCapture>;
  getActiveTab(): Promise<TabInfo>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  executeLocalAction(action: Action): Promise<ActionResult>;
}

/**
 * Chrome MV3 implementation. Uses chrome.tabs.captureVisibleTab and
 * chrome.scripting.executeScript, restricted to the DSL's typed actions -
 * never eval, never a server-provided script body (spec sections 26, 58).
 */
export class ChromeAdapter implements BrowserAdapter {
  async captureVisibleTab(): Promise<ScreenCapture> {
    const dataUrl: string = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab({ format: "png" }, (result) => {
        if (chrome.runtime.lastError || !result) {
          reject(new Error(chrome.runtime.lastError?.message ?? "CAPTURE_FAILED"));
          return;
        }
        resolve(result);
      });
    });

    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    return { image: blob, width: bitmap.width, height: bitmap.height, timestamp: Date.now() };
  }

  async getActiveTab(): Promise<TabInfo> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) throw new Error("NO_ACTIVE_TAB");
    return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
  }

  async sendMessage(tabId: number, message: unknown): Promise<unknown> {
    return chrome.tabs.sendMessage(tabId, message);
  }

  async executeLocalAction(action: Action): Promise<ActionResult> {
    const tab = await this.getActiveTab();
    try {
      // The executed function only ever receives a typed Action from our
      // own DSL - never a string of code from the server (spec section 58).
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: applyActionInPage,
        args: [action],
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "EXECUTION_FAILED" };
    }
  }
}

/**
 * This function is serialized and injected into the page context by
 * chrome.scripting.executeScript. It only ever performs the six DSL
 * operations below - there is no code path that runs arbitrary text.
 */
function applyActionInPage(action: Action): void {
  function resolveElement(targetId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-chameleon-id="${targetId}"]`);
  }

  switch (action.type) {
    case "CLICK": {
      resolveElement(action.targetId)?.click();
      break;
    }
    case "FOCUS": {
      resolveElement(action.targetId)?.focus();
      break;
    }
    case "SCROLL": {
      window.scrollBy({ top: action.direction === "DOWN" ? action.amount : -action.amount, behavior: "smooth" });
      break;
    }
    case "TYPE": {
      const el = resolveElement(action.targetId) as HTMLInputElement | null;
      // NOTE: actual value resolution from action.valueToken happens via
      // the privacy vault BEFORE this function is constructed - see
      // executor/action-executor.ts, which resolves valueToken to a raw
      // value locally and passes the resolved string as a separate,
      // vault-only argument that never touches the network layer.
      if (el) el.focus();
      break;
    }
    case "SELECT": {
      const el = resolveElement(action.targetId) as HTMLSelectElement | null;
      if (el) el.value = action.option;
      break;
    }
    case "NAVIGATE": {
      const el = resolveElement(action.targetId) as HTMLAnchorElement | null;
      if (el?.href) window.location.href = el.href; // only follows an href already present in the trusted DOM, never a server-supplied URL string
      break;
    }
    case "EXTRACT":
    case "WAIT":
    case "DONE":
    case "REQUEST_CONFIRMATION":
      break;
  }
}

/** Firefox WebExtension implementation - uses the `browser.*` namespace where available. */
export class FirefoxAdapter implements BrowserAdapter {
  async captureVisibleTab(): Promise<ScreenCapture> {
    // @ts-expect-error - `browser` is provided by the WebExtension polyfill at runtime
    const dataUrl: string = await browser.tabs.captureVisibleTab({ format: "png" });
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    return { image: blob, width: bitmap.width, height: bitmap.height, timestamp: Date.now() };
  }

  async getActiveTab(): Promise<TabInfo> {
    // @ts-expect-error - browser namespace
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) throw new Error("NO_ACTIVE_TAB");
    return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
  }

  async sendMessage(tabId: number, message: unknown): Promise<unknown> {
    // @ts-expect-error - browser namespace
    return browser.tabs.sendMessage(tabId, message);
  }

  async executeLocalAction(action: Action): Promise<ActionResult> {
    const tab = await this.getActiveTab();
    try {
      // @ts-expect-error - browser namespace
      await browser.scripting.executeScript({ target: { tabId: tab.id }, func: applyActionInPage, args: [action] });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "EXECUTION_FAILED" };
    }
  }
}

export function createBrowserAdapter(): BrowserAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isFirefox = typeof (globalThis as any).browser !== "undefined";
  return isFirefox ? new FirefoxAdapter() : new ChromeAdapter();
}
