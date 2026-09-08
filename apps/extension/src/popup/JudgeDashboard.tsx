import React, { useEffect, useState } from "react";
import type { AgentStatusMessage } from "../background/message-router.js";

const initialStatus: AgentStatusMessage = {
  type: "AGENT_STATUS",
  client: { localVision: "READY", ocr: "READY", privacyEngine: "ACTIVE", firewall: "ACTIVE", actionValidator: "ACTIVE" },
  server: { api: "UNKNOWN", provider: "mock" },
  privacy: { rawPiiSent: 0, sensitiveDetected: 0, redacted: 0, blocked: 0 },
  performance: { totalMs: 0, timings: {} },
  agentState: "IDLE",
  lastActionConfidence: null,
};

/**
 * This is CHAMELEON's "SYSTEM / JUDGE VIEW" dashboard. It is a pure
 * presentational component driven entirely by messages relayed from the
 * background service worker (which aggregates telemetry from the content
 * script's agent loop) - it holds no privacy-sensitive state itself.
 */
export function JudgeDashboard(): React.ReactElement {
  const [status, setStatus] = useState<AgentStatusMessage>(initialStatus);

  useEffect(() => {
    function handleMessage(message: unknown) {
      if (isAgentStatusMessage(message)) {
        setStatus(message);
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage);
    chrome.runtime.sendMessage({ type: "REQUEST_STATUS" });
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>🦎 CHAMELEON</h2>
      <StatusRow label="Local Vision" value={status.client.localVision} />
      <StatusRow label="OCR" value={status.client.ocr} />
      <StatusRow label="Privacy Engine" value={status.client.privacyEngine} />
      <StatusRow label="Firewall" value={status.client.firewall} />
      <StatusRow label="Server" value={status.server.api} />

      <Section title="PRIVACY">
        <Metric label="Sensitive detected" value={status.privacy.sensitiveDetected} />
        <Metric label="Redacted" value={status.privacy.redacted} />
        <Metric label="Blocked" value={status.privacy.blocked} />
        <Metric label="Raw PII sent" value={status.privacy.rawPiiSent} highlightZero />
      </Section>

      <Section title="PERFORMANCE (measured)">
        {Object.entries(status.performance.timings).map(([stage, ms]) => (
          <Metric key={stage} label={stage} value={`${(ms as number).toFixed(0)} ms`} />
        ))}
        <Metric label="Total" value={`${status.performance.totalMs.toFixed(0)} ms`} />
      </Section>

      <Section title="AGENT">
        <Metric label="State" value={status.agentState} />
        <Metric
          label="Action confidence"
          value={
            status.lastActionConfidence === null
              ? "—"
              : `${(status.lastActionConfidence * 100).toFixed(0)}%`
          }
        />
      </Section>
    </div>
  );
}

function isAgentStatusMessage(m: unknown): m is AgentStatusMessage {
  return typeof m === "object" && m !== null && (m as { type?: string }).type === "AGENT_STATUS";
}

function StatusRow({ label, value }: { label: string; value: string }) {
  const color = value === "READY" || value === "ACTIVE" || value === "CONNECTED" ? "#3fb950" : "#8b949e";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" }}>
      <span>{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #30363d", paddingTop: 8 }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4, letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  );
}

function Metric({ label, value, highlightZero }: { label: string; value: string | number; highlightZero?: boolean }) {
  const isZero = value === 0 || value === "0";
  const color = highlightZero ? (isZero ? "#3fb950" : "#f85149") : "#e6edf3";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "1px 0" }}>
      <span style={{ color: "#8b949e" }}>{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}
