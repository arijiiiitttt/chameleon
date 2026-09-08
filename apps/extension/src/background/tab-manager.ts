import type { AgentStatusMessage } from "./message-router.js";

/**
 * Tracks one AgentStatusMessage per tab so the popup always shows the
 * status for whichever tab is currently active, and so state from one tab
 * never leaks into another (extension isolation, spec section 53).
 */
export class TabManager {
  private statusByTab = new Map<number, AgentStatusMessage>();

  setStatus(tabId: number, status: AgentStatusMessage): void {
    this.statusByTab.set(tabId, status);
  }

  getStatus(tabId: number): AgentStatusMessage | undefined {
    return this.statusByTab.get(tabId);
  }

  clear(tabId: number): void {
    this.statusByTab.delete(tabId);
  }
}
