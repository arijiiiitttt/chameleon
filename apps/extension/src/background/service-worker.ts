import { isRuntimeMessage, type AgentStatusMessage } from "./message-router.js";
import { TabManager } from "./tab-manager.js";

const tabManager = new TabManager();

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
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      const status = tabId !== undefined ? tabManager.getStatus(tabId) : undefined;
      if (status) sendResponse(status);
    });
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
    // chrome.tabs.captureVisibleTab is ONLY callable from a background/
    // service-worker context, never from a content script - this is why
    // the VLM screenshot channel needs this extra hop instead of the
    // content script capturing directly. The captured PNG is a raw,
    // UNREDACTED screenshot at this point - it is returned to the
    // requesting content script and MUST be pixel-redacted there
    // (content-script.ts calls applyImageRedaction against the privacy
    // pipeline's own imageRedactionRegions) before it can ever become
    // part of a sanitized payload. This handler itself sends nothing
    // over the network and stores nothing - it is a one-shot relay.
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
    return true; // keep the message channel open for the async sendResponse
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => tabManager.clear(tabId));
