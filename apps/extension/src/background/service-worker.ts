import { isRuntimeMessage, type AgentStatusMessage } from "./message-router.js";
import { TabManager } from "./tab-manager.js";

const tabManager = new TabManager();

// Must match the value used in the content script / Vite env.
const SERVER_URL = "http://localhost:8787";

const defaultStatus: AgentStatusMessage = {
  type: "AGENT_STATUS",
  client: {
    localVision: "READY",
    ocr: "READY",
    privacyEngine: "ACTIVE",
    firewall: "ACTIVE",
    actionValidator: "ACTIVE",
  },
  server: { api: "UNKNOWN", provider: "—" },
  privacy: { rawPiiSent: 0, sensitiveDetected: 0, redacted: 0, blocked: 0 },
  performance: { totalMs: 0, timings: {} },
  agentState: "IDLE",
  lastActionConfidence: null,
};

/** Live health check against the reasoning server. */
async function checkServerHealth(): Promise<{ api: "CONNECTED" | "DISCONNECTED"; provider: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    const res = await fetch(`${SERVER_URL}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { api: "DISCONNECTED", provider: "—" };
    }

    const body = (await res.json()) as { status?: string; aiProvider?: string };
    return {
      api: body.status === "ok" ? "CONNECTED" : "DISCONNECTED",
      provider: body.aiProvider ?? "unknown",
    };
  } catch {
    return { api: "DISCONNECTED", provider: "—" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRuntimeMessage(message)) return false;

  if (message.type === "AGENT_STATUS" && sender.tab?.id !== undefined) {
    tabManager.setStatus(sender.tab.id, message as AgentStatusMessage);
    // Fan out to the popup, if open.
    chrome.runtime.sendMessage(message).catch(() => {
      /* no popup listening - ignore */
    });
    return false;
  }

  if (message.type === "REQUEST_STATUS") {
    // Always do a live health check so the popup reflects reality.
    (async () => {
      const health = await checkServerHealth();

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        const cached = tabId !== undefined ? tabManager.getStatus(tabId) : undefined;

        const status: AgentStatusMessage = {
          ...(cached ?? defaultStatus),
          type: "AGENT_STATUS",
          server: {
            api: health.api,
            provider: health.provider,
          },
        };

        sendResponse(status);
      });
    })();

    return true; // keep the message channel open for the async sendResponse
  }

  if (message.type === "START_TASK" && sender.tab === undefined) {
    // Forwarded from the popup to the active tab's content script.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) chrome.tabs.sendMessage(tabId, message);
    });
    return false;
  }

  if (message.type === "CAPTURE_VISIBLE_TAB") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ type: "CAPTURE_VISIBLE_TAB_RESULT", dataUrl: null, error: "NO_SENDER_TAB" });
      return false;
    }
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({
          type: "CAPTURE_VISIBLE_TAB_RESULT",
          dataUrl: null,
          error: chrome.runtime.lastError?.message ?? "CAPTURE_FAILED",
        });
        return;
      }
      sendResponse({ type: "CAPTURE_VISIBLE_TAB_RESULT", dataUrl });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => tabManager.clear(tabId));