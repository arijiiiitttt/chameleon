import { isRuntimeMessage, type AgentStatusMessage } from "./message-router.js";
import { TabManager } from "./tab-manager.js";

const tabManager = new TabManager();

// Now the single source of truth for the reasoning-server URL, since the
// content script's callServer() relays through here instead of fetching
// directly (see content-script.ts). Still reads the same Vite env var the
// content script used to, so existing .env / VITE_SERVER_URL setups keep
// working unchanged.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787";

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
async function checkServerHealth(): Promise<{
  api: "CONNECTED" | "DISCONNECTED";
  provider: string;
}> {
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

  // Status updates coming from the content script
  if (message.type === "AGENT_STATUS" && sender.tab?.id !== undefined) {
    tabManager.setStatus(sender.tab.id, message as AgentStatusMessage);
    // Fan-out to the popup (if open). Ignore if nobody is listening.
    chrome.runtime.sendMessage(message).catch(() => {});
    return false;
  }

  // Popup asks for current status
  if (message.type === "REQUEST_STATUS") {
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

    return true; // keep channel open for the async reply
  }

  // Popup → active tab content script
  if (message.type === "START_TASK" && sender.tab === undefined) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const tabId = tab?.id;
      const tabUrl = tab?.url ?? "";

      // Chrome refuses to run content scripts on internal pages
      // (chrome://, the Web Store, a blank New Tab page, PDF viewer, etc.)
      // regardless of the manifest's "matches" pattern. Previously this
      // failed completely silently - the popup would optimistically show
      // OBSERVING for 600ms and then just snap back to IDLE with zero
      // explanation, which looks exactly like "the task runs and
      // immediately stops". Detect it up front and report a real reason.
      const isRestrictedUrl =
        /^(chrome|chrome-extension|edge|about|devtools):/i.test(tabUrl) ||
        tabUrl === "" ||
        tabUrl.startsWith("https://chrome.google.com/webstore");

      if (tabId === undefined || isRestrictedUrl) {
        console.error(
          "[CHAMELEON] Cannot start task: active tab is not eligible for content-script injection.",
          { tabId, tabUrl }
        );
        tabManager.setStatus(tabId ?? -1, {
          ...defaultStatus,
          agentState: "FAILED",
        });
        chrome.runtime
          .sendMessage({
            ...defaultStatus,
            type: "AGENT_STATUS",
            agentState: "FAILED",
          })
          .catch(() => {});
        return;
      }

      chrome.tabs.sendMessage(tabId, message).catch((firstErr) => {
        // Most common cause: the extension was reloaded/updated after this
        // tab was already open, so the OLD content script instance is
        // gone and no new one was auto-injected into the existing tab
        // (Chrome only auto-injects on fresh navigations). Rather than
        // just failing, re-inject content.js into the live tab and retry
        // once before giving up for real.
        chrome.scripting
          .executeScript({ target: { tabId }, files: ["content.js"] })
          .then(() => chrome.tabs.sendMessage(tabId, message))
          .catch((retryErr) => {
            console.error(
              "[CHAMELEON] Failed to deliver START_TASK to content script (after re-inject attempt):",
              { firstErr, retryErr, tabId, tabUrl }
            );
            tabManager.setStatus(tabId, { ...defaultStatus, agentState: "FAILED" });
            chrome.runtime
              .sendMessage({ ...defaultStatus, type: "AGENT_STATUS", agentState: "FAILED" })
              .catch(() => {});
          });
      });
    });
    // IMPORTANT: do NOT call sendResponse and return false
    // so the popup must not wait for a reply.
    return false;
  }

  // Reasoning-server relay: content scripts run in the WEBPAGE's security
  // context, so a fetch() made directly from content-script.ts is subject
  // to that page's CSP and mixed-content rules - e.g. any https:// page
  // silently blocks an active fetch to http://localhost:8787 (mixed
  // content), with no catchable JS error, which looks exactly like
  // "the task always fails, no console error, on every real website".
  // The background service worker has its own origin and is governed only
  // by this extension's host_permissions, so routing the call through here
  // avoids that entirely - same relay pattern already used for
  // CAPTURE_VISIBLE_TAB below.
  if (message.type === "CALL_REASONING_SERVER") {
    (async () => {
      try {
        const controller = new AbortController();
        // 30s was too tight for free-tier OpenRouter models, which can be
        // slow to cold-start or queued behind rate limits - bumped to 90s.
        // Passing an explicit reason means a future timeout shows up as
        // "REASONING_SERVER_TIMEOUT_90S" instead of the opaque default
        // "signal is aborted without reason".
        const timeout = setTimeout(() => controller.abort("REASONING_SERVER_TIMEOUT_90S"), 90000);
        const res = await fetch(`${SERVER_URL}/api/v1/reason`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.body),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          sendResponse({
            type: "CALL_REASONING_SERVER_RESULT",
            ok: false,
            error: `SERVER_HTTP_${res.status}`,
          });
          return;
        }
        const data = await res.json();
        sendResponse({ type: "CALL_REASONING_SERVER_RESULT", ok: true, data });
      } catch (err) {
        // With an abort reason set above, err.message will now be
        // "REASONING_SERVER_TIMEOUT_90S" for a timeout instead of the
        // opaque default "signal is aborted without reason".
        sendResponse({
          type: "CALL_REASONING_SERVER_RESULT",
          ok: false,
          error: err instanceof Error ? err.message : "SERVER_CALL_FAILED",
        });
      }
    })();
    return true; // keep channel open for the async reply
  }

  // Screenshot capture relay (used by VLM path)
  if (message.type === "CAPTURE_VISIBLE_TAB") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        type: "CAPTURE_VISIBLE_TAB_RESULT",
        dataUrl: null,
        error: "NO_SENDER_TAB",
      });
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