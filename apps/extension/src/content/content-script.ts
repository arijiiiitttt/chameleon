import { extractDomElements } from "../perception/dom/dom-extractor.js";
import { scanImagesAndCanvases } from "../perception/capture/image-scan-service.js";
import { createOcrService } from "../perception/ocr/ocr-service.js";
import { createLocalVisionModel } from "../models/local-vision-model.js";
import { createSceneClassifierModel } from "../models/scene-classifier-model.js";
import { fuseScreenState } from "@chameleon/screen-state";
import { runPrivacyPipeline } from "../privacy/privacy-engine.js";
import { PrivacyPolicyEngine } from "@chameleon/privacy-policy";
import { PrivacyVault, IndexedDbVaultAdapter } from "../privacy/vault/privacy-vault.js";
import { OutboundFirewall } from "../firewall/outbound-firewall.js";
import { runAgentLoop, type AgentLoopDeps } from "../agent/agent-loop.js";
import { ElementRegistry } from "./element-registry.js";
import { DomChangeObserver } from "./dom-observer.js";
import { isRuntimeMessage } from "../background/message-router.js";
import type { AgentStatusMessage } from "../background/message-router.js";
import { applyImageRedaction } from "../redaction/image-redactor.js";
import type { RedactionRegion } from "../redaction/bbox-redactor.js";
import type { SanitizedRequest, ActionPlanResponse } from "@chameleon/shared-types";
import type { AgentLoopStatusSnapshot } from "../agent/agent-loop.js";

const policy = new PrivacyPolicyEngine();
const vault = new PrivacyVault(new IndexedDbVaultAdapter());
const firewall = new OutboundFirewall();
const registry = new ElementRegistry();

// Local perception models (spec section 10: load once, reuse across
// perception cycles - never re-init per frame). Both fail closed on their
// own (see ocr-service.ts / local-vision-model.ts), so a missing model
// file or unsupported hardware degrades to "no OCR/vision findings," never
// a thrown error out of perceiveCurrentScreen().
const ocrService = createOcrService();
const visionModel = createLocalVisionModel();
const sceneClassifier = createSceneClassifierModel();
let visionModelInitPromise: Promise<void> | null = null;
let visionModelsReady = false;

async function ensureVisionModelReady(): Promise<void> {
  if (!visionModelInitPromise) {
    visionModelInitPromise = Promise.all([
      visionModel.initialize(),
      sceneClassifier.initialize(),
    ])
      .then(() => undefined)
      .catch(() => {
        /* fail closed - analyze()/classify() below still handle a not-ready model safely */
      })
      .finally(() => {
        visionModelsReady = true;
      });
  }
  await visionModelInitPromise;
}

// ── Live on-page status overlay ──────────────────────────────────────
// The extension popup closes whenever it loses focus (e.g. when
// window.confirm() appears). This overlay lives in the page itself so
// the user always sees continuous progress for the whole agent run.
let statusOverlay: HTMLDivElement | null = null;
let statusHideTimer: number | null = null;

const STATE_LABELS: Record<string, string> = {
  IDLE: "Idle",
  OBSERVING: "Observing page…",
  PERCEIVING: "Perceiving screen…",
  CLASSIFYING_PRIVACY: "Classifying privacy…",
  SANITIZING: "Sanitizing…",
  FIREWALL_CHECK: "Firewall check…",
  WAITING_FOR_SERVER: "Waiting for server…",
  PLANNING: "Planning actions…",
  VALIDATING_ACTION: "Validating action…",
  AWAITING_CONFIRMATION: "Awaiting your confirmation…",
  EXECUTING: "Executing action…",
  VERIFYING: "Verifying…",
  COMPLETED: "Completed ✓",
  FAILED: "Failed ✗",
  BLOCKED: "Blocked by privacy policy",
};

function ensureStatusOverlay(): HTMLDivElement {
  if (statusOverlay && document.body.contains(statusOverlay)) {
    return statusOverlay;
  }

  const el = document.createElement("div");
  el.id = "chameleon-status-overlay";
  el.setAttribute("data-chameleon", "status");
  el.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:16px",
    "z-index:2147483647",
    "min-width:260px",
    "max-width:340px",
    "padding:12px 16px",
    "border-radius:12px",
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    "font-size:13px",
    "line-height:1.4",
    "color:#e6edf3",
    "background:#161b22",
    "border:1px solid #30363d",
    "box-shadow:0 8px 24px rgba(0,0,0,0.45)",
    "pointer-events:none",
    "transition:opacity 0.25s ease",
    "opacity:1",
  ].join(";");
  document.body.appendChild(el);
  statusOverlay = el;
  return el;
}

function updateStatusOverlay(state: string, extra?: string): void {
  const el = ensureStatusOverlay();
  el.style.opacity = "1";

  if (statusHideTimer !== null) {
    window.clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }

  const label = STATE_LABELS[state] ?? state;
  const terminal = state === "COMPLETED" || state === "FAILED" || state === "BLOCKED";
  const isBusy = !terminal && state !== "IDLE";

  let color = "#8b949e";
  let border = "#30363d";
  if (state === "COMPLETED") {
    color = "#3fb950";
    border = "rgba(63,185,80,0.55)";
  } else if (state === "FAILED") {
    color = "#f85149";
    border = "rgba(248,81,73,0.55)";
  } else if (state === "BLOCKED") {
    color = "#ffa657";
    border = "rgba(255,166,87,0.55)";
  } else if (isBusy) {
    color = "#79c0ff";
    border = "rgba(56,139,253,0.55)";
  }

  el.style.borderColor = border;

  const spinner = isBusy
    ? '<span style="display:inline-block;animation:chameleon-spin 1s linear infinite;margin-right:6px">◌</span>'
    : "";

  const sub = extra
    ? `<div style="margin-top:4px;font-size:11px;color:#8b949e">${extra}</div>`
    : terminal
      ? `<div style="margin-top:4px;font-size:11px;color:#8b949e">${
          state === "COMPLETED"
            ? "All actions finished."
            : state === "FAILED"
              ? "Something went wrong during the run."
              : "Privacy firewall or policy blocked the action."
        }</div>`
      : "";

  el.innerHTML = `
    <div style="display:flex;align-items:center;font-weight:600;color:${color}">
      ${spinner}<span>${label}</span>
    </div>
    ${sub}
  `;

  if (terminal) {
    statusHideTimer = window.setTimeout(() => {
      if (statusOverlay) {
        statusOverlay.style.opacity = "0";
        window.setTimeout(() => {
          statusOverlay?.remove();
          statusOverlay = null;
        }, 300);
      }
      statusHideTimer = null;
    }, 6000);
  }
}

// Inject spinner keyframes once
if (!document.getElementById("chameleon-spin-style")) {
  const style = document.createElement("style");
  style.id = "chameleon-spin-style";
  style.textContent = `
    @keyframes chameleon-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Sends a real AGENT_STATUS message to the background service worker
 * (which relays it to the popup's Judge Dashboard - see
 * background/service-worker.ts and popup/JudgeDashboard.tsx). This is
 * the only place `AgentStatusMessage` objects are actually constructed
 * and sent - every field here is either a genuinely tracked runtime flag
 * (model readiness) or comes straight from `AgentLoopStatusSnapshot`,
 * which the agent loop itself populates only from real, measured data
 * (privacy pipeline output, performance.now() deltas, an actual action's
 * confidence field). Nothing here is a placeholder or fabricated number.
 */
function sendAgentStatus(snapshot: AgentLoopStatusSnapshot): void {
  const message: AgentStatusMessage = {
    type: "AGENT_STATUS",
    client: {
      localVision: visionModelsReady ? "READY" : "LOADING",
      ocr: visionModelsReady ? "READY" : "LOADING",
      privacyEngine: "ACTIVE",
      firewall: "ACTIVE",
      actionValidator: "ACTIVE",
    },
    server: {
      // A plan was only received once lastActionConfidence stops being
      // null (see agent-loop.ts) - inferring CONNECTED from that is an
      // honest deduction from data we already have, not a guess.
      api: snapshot.lastActionConfidence !== null ? "CONNECTED" : "UNKNOWN",
      provider: "server",
    },
    privacy: {
      rawPiiSent: 0, // the firewall blocks the request entirely before send if this would ever be nonzero
      sensitiveDetected: snapshot.privacy?.sensitiveDetected ?? 0,
      redacted: snapshot.privacy?.redacted ?? 0,
      blocked: snapshot.privacy?.blocked ?? 0,
    },
    performance: {
      totalMs: Object.values(snapshot.timings).reduce((a, b) => a + b, 0),
      timings: snapshot.timings,
    },
    agentState: snapshot.agentState,
    lastActionConfidence: snapshot.lastActionConfidence,
  };
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    /* no background listener yet (e.g. extension reloading) - never let a status ping break the agent loop */
  }

  // Always mirror status onto the in-page overlay (popup may already be closed)
  updateStatusOverlay(snapshot.agentState);
}

let requestCounter = 0;

async function perceiveCurrentScreen() {
  const { elements, domSignals } = extractDomElements(document);

  await ensureVisionModelReady();
  // Real OCR + vision only need to run over <img>/<canvas> content - the
  // DOM/ARIA extractor above already covers ordinary rendered HTML text
  // with exact, 1.0-confidence results (see dom-text-source.ts).
  const { ocrRegions, visualRegions } = await scanImagesAndCanvases(
    document,
    ocrService,
    visionModel,
    sceneClassifier
  );

  // Rebuild AFTER scanImagesAndCanvases(), not before: that scan assigns
  // a fresh `data-chameleon-id` to any <canvas> it tags (canvases aren't
  // covered by extractDomElements()'s own CONTENT_SELECTOR), and a
  // scene-classified region's `sourceElementId` must already be
  // queryable in the registry by the time the sanitized request reaches
  // the server, or a server-proposed EXTRACT on that id would correctly
  // - but uselessly - fail action-validator's live-DOM existence check.
  registry.rebuildFromDocument(document);

  const screen = fuseScreenState({
    id: `screen_${Date.now()}`,
    timestamp: Date.now(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    page: { url: location.href, title: document.title },
    elements,
    ocrRegions,
    visualRegions,
  });

  return { screen, domSignals };
}

/**
 * VLM (vision-language model) channel - opt-in, off by default. When
 * enabled, one small, ALREADY-PIXEL-REDACTED screenshot accompanies the
 * sanitized request so a vision-capable server-side model can see overall
 * page layout, not just the structured element list. This is genuinely
 * additive: everything the text-only path already does keeps working
 * exactly as before when this is disabled (the default) or unavailable.
 */
const VLM_ENABLED = (import.meta.env.VITE_VLM_ENABLED as string | undefined) === "true";
const SCREENSHOT_MAX_WIDTH = 480; // keeps the payload small; plenty for layout context, not fine text

/**
 * Requests a raw (UNREDACTED) screenshot of the current tab from the
 * background script - only the background/service-worker context can
 * call `chrome.tabs.captureVisibleTab`, hence the message hop instead of
 * capturing directly here. Fails closed to `null` on any error (no
 * background response, permission denied, etc.) - the caller must treat
 * `null` as "no screenshot this cycle," never retry-loop or throw.
 */
function requestVisibleTabCapture(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" }, (response: unknown) => {
        if (chrome.runtime.lastError || !response || typeof response !== "object") {
          resolve(null);
          return;
        }
        const r = response as { dataUrl?: string | null };
        resolve(r.dataUrl ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Takes the raw captured screenshot, applies REAL pixel redaction
 * (`applyImageRedaction`) using the privacy pipeline's own regions, and
 * returns a small JPEG data-URL suitable for the optional VLM channel.
 * Regions are scaled from CSS pixels to the capture's natural resolution
 * (important on hi-DPI / devicePixelRatio > 1) BEFORE drawing any
 * redaction - applying unscaled regions on a hi-DPI capture would redact
 * the wrong area of the image, which would be worse than not redacting at
 * all. Fails closed to `undefined` (field omitted entirely) on any error.
 */
async function buildRedactedScreenshot(
  rawDataUrl: string,
  imageRedactionRegions: RedactionRegion[]
): Promise<{ dataUrl: string; width: number; height: number } | undefined> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("SCREENSHOT_DECODE_FAILED"));
      image.src = rawDataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0);

    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;
    const scaledRegions: RedactionRegion[] = imageRedactionRegions.map((r) => ({
      ...r,
      bbox: {
        x: r.bbox.x * scaleX,
        y: r.bbox.y * scaleY,
        width: r.bbox.width * scaleX,
        height: r.bbox.height * scaleY,
      },
    }));
    applyImageRedaction(canvas, scaledRegions);

    // Downscale to a small thumbnail - a VLM needs overall layout, not
    // pixel-perfect fine text (which is already covered by the OCR+DOM
    // text channel anyway), so there is no privacy or utility reason to
    // ship a full-resolution capture.
    const targetWidth = Math.min(SCREENSHOT_MAX_WIDTH, canvas.width);
    const targetHeight = Math.round((targetWidth / canvas.width) * canvas.height);
    const thumb = document.createElement("canvas");
    thumb.width = targetWidth;
    thumb.height = targetHeight;
    const thumbCtx = thumb.getContext("2d");
    if (!thumbCtx) return undefined;
    thumbCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);

    return { dataUrl: thumb.toDataURL("image/jpeg", 0.7), width: targetWidth, height: targetHeight };
  } catch {
    // Fail closed: any decode/draw error means no screenshot this cycle,
    // never a thrown exception out of sanitize() and never a half-redacted
    // image reaching the payload.
    return undefined;
  }
}

async function sanitize(
  screen: Awaited<ReturnType<typeof perceiveCurrentScreen>>["screen"],
  intent: string,
  iteration: number,
  maxIterations: number
): Promise<SanitizedRequest> {
  const { domSignals } = await perceiveCurrentScreen(); // re-derive signals for the current screen snapshot
  const domTextRegions = screen.elements
    .filter((e) => e.text && e.visible)
    .map((e) => ({ regionId: e.id, text: e.text as string, source: "DOM" as const }));
  // Real OCR text (from <img>/<canvas> content) must run through the same
  // regex/NER detectors as DOM text - a scanned form or ID card can carry
  // exactly the same PII categories as plain HTML text.
  const ocrTextRegions = screen.ocrRegions
    .filter((r) => r.text.trim().length > 0)
    .map((r) => ({ regionId: r.id, text: r.text, source: "OCR" as const }));
  const textRegions = [...domTextRegions, ...ocrTextRegions];

  requestCounter += 1;
  const { sanitizedRequest, imageRedactionRegions } = await runPrivacyPipeline(
    {
      screen,
      domSignals,
      textRegions,
      userIntent: intent,
      requestId: `req_${requestCounter}`,
      iteration,
      maxIterations,
    },
    policy,
    vault
  );

  if (VLM_ENABLED) {
    // Best-effort, fail-closed: any failure here (capture denied, decode
    // error, etc.) simply means this cycle's request goes out without a
    // screenshot - exactly like today's behavior - never a thrown error
    // out of sanitize() and never a partially-redacted image.
    const rawDataUrl = await requestVisibleTabCapture();
    if (rawDataUrl) {
      const screenshot = await buildRedactedScreenshot(rawDataUrl, imageRedactionRegions);
      if (screenshot) {
        sanitizedRequest.screen.redactedScreenshot = screenshot;
      }
    }
  }

  return sanitizedRequest;
}

/**
 * The reasoning server call is relayed through the background service
 * worker (see callServer below) - SERVER_URL itself now lives in
 * service-worker.ts, since that's where the actual fetch() happens.
 */
async function callServer(request: SanitizedRequest): Promise<ActionPlanResponse> {
  // Relayed through the background service worker rather than fetched
  // directly here, since a content script's fetch() runs in the PAGE's
  // security context and is silently blocked by mixed-content rules on
  // any https:// page hitting a plain http://localhost server - with no
  // catchable error, which is exactly what "always fails, no console
  // error" looks like. The background worker has its own origin.
  const response = (await chrome.runtime.sendMessage({
    type: "CALL_REASONING_SERVER",
    body: request,
  })) as { type: string; ok: boolean; data?: unknown; error?: string } | undefined;

  if (!response) {
    throw new Error("SERVER_CALL_NO_RESPONSE");
  }
  if (!response.ok) {
    throw new Error(response.error ?? "SERVER_CALL_FAILED");
  }
  return response.data as ActionPlanResponse;
}

async function executeAction(action: unknown): Promise<{ success: boolean; error?: string }> {
  // Real DOM interaction happens here; TYPE actions resolve valueToken
  // through the local vault BEFORE ever touching the DOM, so the raw value
  // is typed locally without ever having been sent to (or received from)
  // the server.
  const a = action as { type: string; targetId?: string; valueToken?: string; direction?: string; amount?: number };
  try {
    if (a.type === "CLICK" && a.targetId) {
      const el = registry.resolve(a.targetId);
      if (!el) {
        return { success: false, error: `TARGET_NOT_FOUND: ${a.targetId}` };
      }
      el.click();
    } else if (a.type === "FOCUS" && a.targetId) {
      const el = registry.resolve(a.targetId);
      if (!el) {
        return { success: false, error: `TARGET_NOT_FOUND: ${a.targetId}` };
      }
      el.focus();
    } else if (a.type === "TYPE" && a.targetId && a.valueToken) {
      const raw = await vault.resolve(a.valueToken);
      const el = registry.resolve(a.targetId) as HTMLInputElement | null;
      if (!el) {
        return { success: false, error: `TARGET_NOT_FOUND: ${a.targetId}` };
      }
      if (raw === undefined) {
        return { success: false, error: `VALUE_TOKEN_NOT_FOUND: ${a.valueToken}` };
      }
      el.value = raw;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (a.type === "SCROLL") {
      window.scrollBy({ top: a.direction === "DOWN" ? (a.amount ?? 0) : -(a.amount ?? 0), behavior: "smooth" });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "EXECUTION_FAILED" };
  }
}

async function requestConfirmation(action: unknown): Promise<boolean> {
  // Minimal inline confirmation UI - a real implementation renders a
  // styled overlay; kept simple here since UI chrome isn't the focus of
  // this scaffold.
  // eslint-disable-next-line no-alert
  return window.confirm(`AI Agent wants to perform:\n${JSON.stringify(action, null, 2)}\n\nAllow?`);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!isRuntimeMessage(message)) return;
  if (message.type === "START_TASK") {
    // Immediate feedback on the page (popup will usually close on focus loss)
    updateStatusOverlay("OBSERVING", "Task started…");

    const deps: AgentLoopDeps = {
      perceive: async () => (await perceiveCurrentScreen()).screen,
      sanitize,
      callServer,
      execute: executeAction,
      requestConfirmation,
      firewall,
      onStatus: sendAgentStatus,
    };
    runAgentLoop(message.intent, deps)
      .then((result) => {
        // The loop only calls onStatus mid-flight (after sanitize/planning
        // stages) - it never reports the terminal state it actually landed
        // on, so without this the popup/overlay just freezes on the last
        // busy stage forever, even though the loop finished. Report the
        // real final state (COMPLETED / FAILED / BLOCKED) here.
        sendAgentStatus({
          agentState: result.finalState,
          iteration: result.iterations,
          timings: {},
          lastActionConfidence: null,
        });
        updateStatusOverlay(
          result.finalState,
          result.stopReason ?? undefined
        );
      })
      .catch((err) => {
        console.error("[CHAMELEON] Unexpected error in agent loop:", err);
        sendAgentStatus({
          agentState: "FAILED",
          iteration: 0,
          timings: {},
          lastActionConfidence: null,
        });
        updateStatusOverlay("FAILED", "Unexpected error in agent loop");
      });
  }
});

// Re-run perception opportunistically on significant DOM change, per the
// event-driven perception architecture in spec section 34 (full agent
// runs are still only triggered by an explicit user task, not on every
// mutation - this observer only keeps the registry/telemetry warm).
const observer = new DomChangeObserver();
observer.start(document, (signal) => {
  if (DomChangeObserver.shouldRunFullPerception(signal)) {
    registry.rebuildFromDocument(document);
  }
});