import React, { useEffect, useState } from "react";
import type { AgentStatusMessage } from "../background/message-router.js";

const initialStatus: AgentStatusMessage = {
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

export function JudgeDashboard(): React.ReactElement {
  const [status, setStatus] = useState<AgentStatusMessage>(initialStatus);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const pullStatus = () => {
    setIsRefreshing(true);
    chrome.runtime.sendMessage({ type: "REQUEST_STATUS" }, (response) => {
      if (chrome.runtime.lastError) {
        setIsRefreshing(false);
        return;
      }
      if (response && response.type === "AGENT_STATUS") {
        setStatus(response as AgentStatusMessage);
      }
      setIsRefreshing(false);
    });
  };

  useEffect(() => {
    function handleMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === "AGENT_STATUS"
      ) {
        setStatus(message as AgentStatusMessage);
      }
    }
    chrome.runtime.onMessage.addListener(handleMessage);
    pullStatus();
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  const serverConnected = status.server.api === "CONNECTED";

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logoRow}>
          <div style={styles.logo}>🦎</div>
          <div>
            <div style={styles.title}>CHAMELEON</div>
            <div style={styles.subtitle}>Privacy-Preserving Visual Agent</div>
          </div>
        </div>
        <button onClick={pullStatus} style={styles.refreshBtn} title="Refresh status">
          {isRefreshing ? "…" : "↻"}
        </button>
      </div>

      {/* Connection Banner */}
      <div
        style={{
          ...styles.banner,
          background: serverConnected ? "rgba(63, 185, 80, 0.12)" : "rgba(248, 81, 73, 0.12)",
          borderColor: serverConnected ? "rgba(63, 185, 80, 0.35)" : "rgba(248, 81, 73, 0.35)",
        }}
      >
        <span style={styles.bannerDot}>
          <span
            style={{
              ...styles.dot,
              background: serverConnected ? "#3fb950" : "#f85149",
              boxShadow: serverConnected
                ? "0 0 8px rgba(63,185,80,0.6)"
                : "0 0 8px rgba(248,81,73,0.5)",
            }}
          />
        </span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {serverConnected ? "Server Connected" : "Server Disconnected"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.75, textTransform: "capitalize" }}>
          {status.server.provider || "—"}
        </span>
      </div>

      {/* Status Pills */}
      <div style={styles.pillsRow}>
        <StatusPill label="Vision" value={status.client.localVision} />
        <StatusPill label="OCR" value={status.client.ocr} />
        <StatusPill label="Privacy" value={status.client.privacyEngine} />
        <StatusPill label="Firewall" value={status.client.firewall} />
      </div>

      {/* Privacy Card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardIcon}>🛡️</span>
          <span style={styles.cardTitle}>Privacy</span>
        </div>
        <div style={styles.metricsGrid}>
          <MetricBox label="Sensitive" value={status.privacy.sensitiveDetected} color="#d2a8ff" />
          <MetricBox label="Redacted" value={status.privacy.redacted} color="#79c0ff" />
          <MetricBox label="Blocked" value={status.privacy.blocked} color="#ffa657" />
          <MetricBox
            label="Raw PII Sent"
            value={status.privacy.rawPiiSent}
            color={status.privacy.rawPiiSent === 0 ? "#3fb950" : "#f85149"}
            highlight
          />
        </div>
      </div>

      {/* Performance Card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardIcon}>⚡</span>
          <span style={styles.cardTitle}>Performance</span>
        </div>
        {Object.keys(status.performance.timings).length === 0 ? (
          <div style={styles.emptyState}>No measurements yet</div>
        ) : (
          <div style={styles.timingList}>
            {Object.entries(status.performance.timings).map(([stage, ms]) => (
              <div key={stage} style={styles.timingRow}>
                <span style={styles.timingLabel}>{stage}</span>
                <span style={styles.timingValue}>{(ms as number).toFixed(0)} ms</span>
              </div>
            ))}
            <div style={{ ...styles.timingRow, borderTop: "1px solid #21262d", marginTop: 4, paddingTop: 6 }}>
              <span style={{ ...styles.timingLabel, fontWeight: 600, color: "#e6edf3" }}>Total</span>
              <span style={{ ...styles.timingValue, fontWeight: 600 }}>
                {status.performance.totalMs.toFixed(0)} ms
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Agent Card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardIcon}>🤖</span>
          <span style={styles.cardTitle}>Agent</span>
        </div>
        <div style={styles.agentRow}>
          <div>
            <div style={styles.agentLabel}>State</div>
            <div style={styles.agentValue}>{status.agentState}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={styles.agentLabel}>Confidence</div>
            <div style={styles.agentValue}>
              {status.lastActionConfidence === null
                ? "—"
                : `${(status.lastActionConfidence * 100).toFixed(0)}%`}
            </div>
          </div>
        </div>
      </div>

      <div style={styles.footer}>ISRO PS 26171 · On-device perception · Fail closed</div>
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  const good = value === "READY" || value === "ACTIVE" || value === "CONNECTED" || value === "OK";
  return (
    <div
      style={{
        ...styles.pill,
        background: good ? "rgba(63, 185, 80, 0.12)" : "rgba(139, 148, 158, 0.12)",
        borderColor: good ? "rgba(63, 185, 80, 0.3)" : "rgba(139, 148, 158, 0.25)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: good ? "#3fb950" : "#8b949e",
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 11, fontWeight: 500 }}>{label}</span>
    </div>
  );
}

function MetricBox({
  label,
  value,
  color,
  highlight,
}: {
  label: string;
  value: number;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        ...styles.metricBox,
        borderColor: highlight ? color + "55" : "#21262d",
        background: highlight ? color + "12" : "#161b22",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#8b949e", marginTop: 2 }}>{label}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "14px 14px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logoRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  logo: {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: "linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    boxShadow: "0 2px 8px rgba(31, 111, 235, 0.35)",
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.3,
    color: "#f0f6fc",
  },
  subtitle: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 1,
  },
  refreshBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: "1px solid #30363d",
    background: "#161b22",
    color: "#e6edf3",
    fontSize: 16,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  banner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid",
  },
  bannerDot: {
    display: "flex",
    alignItems: "center",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
  },
  pillsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  pill: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 9px",
    borderRadius: 20,
    border: "1px solid",
  },
  card: {
    background: "#161b22",
    border: "1px solid #21262d",
    borderRadius: 12,
    padding: "12px 14px",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginBottom: 10,
  },
  cardIcon: {
    fontSize: 14,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#8b949e",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  metricBox: {
    borderRadius: 8,
    border: "1px solid",
    padding: "10px 10px",
    textAlign: "center",
  },
  emptyState: {
    fontSize: 12,
    color: "#8b949e",
    textAlign: "center",
    padding: "8px 0",
  },
  timingList: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  timingRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
  },
  timingLabel: {
    color: "#8b949e",
  },
  timingValue: {
    color: "#e6edf3",
    fontVariantNumeric: "tabular-nums",
  },
  agentRow: {
    display: "flex",
    justifyContent: "space-between",
  },
  agentLabel: {
    fontSize: 11,
    color: "#8b949e",
    marginBottom: 2,
  },
  agentValue: {
    fontSize: 14,
    fontWeight: 600,
    color: "#e6edf3",
  },
  footer: {
    textAlign: "center",
    fontSize: 10,
    color: "#484f58",
    paddingTop: 2,
    paddingBottom: 4,
  },
};