import React, { useEffect, useState, useCallback, useRef } from "react";
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

const DEMO_INTENT = "Analyze satellite anomaly; acknowledge incident.";

/** Human-readable labels for the agent state machine */
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
  COMPLETED: "Completed",
  FAILED: "Failed",
  BLOCKED: "Blocked",
};

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "BLOCKED"]);
const BUSY_STATES = new Set([
  "OBSERVING",
  "PERCEIVING",
  "CLASSIFYING_PRIVACY",
  "SANITIZING",
  "FIREWALL_CHECK",
  "WAITING_FOR_SERVER",
  "PLANNING",
  "VALIDATING_ACTION",
  "AWAITING_CONFIRMATION",
  "EXECUTING",
  "VERIFYING",
]);

export function JudgeDashboard(): React.ReactElement {
  const [status, setStatus] = useState<AgentStatusMessage>(initialStatus);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [intent, setIntent] = useState(DEMO_INTENT);
  const [isStarting, setIsStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const pullStatus = useCallback(() => {
    setIsRefreshing(true);
    chrome.runtime.sendMessage({ type: "REQUEST_STATUS" }, (response) => {
      setIsRefreshing(false);
      if (chrome.runtime.lastError) return;
      if (response && response.type === "AGENT_STATUS") {
        setStatus(response as AgentStatusMessage);
      }
    });
  }, []);

  // Listen for live status pushed from the content script
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
  }, [pullStatus]);

  // Auto-poll while the agent is busy so the UI stays live
  useEffect(() => {
    const busy = BUSY_STATES.has(status.agentState);

    if (busy) {
      if (pollRef.current === null) {
        pollRef.current = window.setInterval(pullStatus, 800);
      }
    } else {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status.agentState, pullStatus]);

  const serverConnected = status.server.api === "CONNECTED";
  const isBusy = BUSY_STATES.has(status.agentState);
  const isTerminal = TERMINAL_STATES.has(status.agentState);
  const canStart =
    serverConnected && !isBusy && !isStarting && intent.trim().length > 0;

  const handleStartTask = () => {
    const trimmed = intent.trim();
    if (!trimmed || !canStart) return;

    setIsStarting(true);

    // Optimistic UI: show that we are starting immediately
    setStatus((prev) => ({
      ...prev,
      agentState: "OBSERVING",
      lastActionConfidence: null,
    }));

    // No response callback — background returns false on purpose
    chrome.runtime.sendMessage({ type: "START_TASK", intent: trimmed });

    setTimeout(() => {
      setIsStarting(false);
      pullStatus();
    }, 600);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && canStart) {
      e.preventDefault();
      handleStartTask();
    }
  };

  const stageLabel = STATE_LABELS[status.agentState] ?? status.agentState;

  // Banner style based on current phase. styles.* lookups are typed
  // `CSSProperties | undefined` under this project's noUncheckedIndexedAccess
  // setting even though every key below is a real, known key — falling back
  // to {} keeps this type-safe without changing any visual behavior.
  let progressBannerStyle: React.CSSProperties = styles.progressIdle ?? {};
  let progressText = status.agentState === "IDLE" ? "Stopped" : "Ready";
  if (isBusy || isStarting) {
    progressBannerStyle = styles.progressBusy ?? {};
    progressText = stageLabel;
  } else if (status.agentState === "COMPLETED") {
    progressBannerStyle = styles.progressSuccess ?? {};
    progressText = "Task completed successfully";
  } else if (status.agentState === "FAILED") {
    progressBannerStyle = styles.progressError ?? {};
    progressText = "Task failed";
  } else if (status.agentState === "BLOCKED") {
    progressBannerStyle = styles.progressBlocked ?? {};
    progressText = "Task blocked by privacy / policy";
  }

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
          background: serverConnected
            ? "rgba(63, 185, 80, 0.12)"
            : "rgba(248, 81, 73, 0.12)",
          borderColor: serverConnected
            ? "rgba(63, 185, 80, 0.35)"
            : "rgba(248, 81, 73, 0.35)",
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
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            opacity: 0.75,
            textTransform: "capitalize",
          }}
        >
          {status.server.provider || "—"}
        </span>
      </div>

      {/* ── Live Progress / Result Banner ── */}
      <div style={progressBannerStyle}>
        <div style={styles.progressRow}>
          {(isBusy || isStarting) && <span style={styles.spinner}>◌</span>}
          {status.agentState === "COMPLETED" && <span>✅</span>}
          {status.agentState === "FAILED" && <span>❌</span>}
          {status.agentState === "BLOCKED" && <span>🛡️</span>}
          <span style={{ fontWeight: 600, fontSize: 13 }}>{progressText}</span>
        </div>
        {(isBusy || isStarting) && (
          <div style={styles.progressSub}>
            Agent is working — do not close this tab
          </div>
        )}
        {isTerminal && status.agentState === "COMPLETED" && (
          <div style={styles.progressSub}>
            All actions finished. Check the page for results.
          </div>
        )}
        {isTerminal && status.agentState === "FAILED" && (
          <div style={styles.progressSub}>
            Something went wrong during perception, reasoning, or execution.
          </div>
        )}
        {isTerminal && status.agentState === "BLOCKED" && (
          <div style={styles.progressSub}>
            Privacy firewall or policy blocked the request / action.
          </div>
        )}
      </div>

      {/* Start Task */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardIcon}>▶</span>
          <span style={styles.cardTitle}>Start Task</span>
        </div>

        <input
          type="text"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Analyze satellite anomaly; acknowledge incident."
          disabled={isBusy || isStarting}
          style={{
            ...styles.input,
            opacity: isBusy || isStarting ? 0.55 : 1,
          }}
        />

        <div style={styles.taskActions}>
          <button
            onClick={handleStartTask}
            disabled={!canStart}
            style={{
              ...styles.startBtn,
              opacity: canStart ? 1 : 0.45,
              cursor: canStart ? "pointer" : "not-allowed",
            }}
          >
            {isStarting
              ? "Starting…"
              : isBusy
                ? "Running…"
                : isTerminal
                  ? "Run Again"
                  : "Start Task"}
          </button>

          <button
            onClick={() => setIntent(DEMO_INTENT)}
            style={styles.demoBtn}
            title="Load demo intent"
            disabled={isBusy || isStarting}
          >
            Demo
          </button>
        </div>

        {!serverConnected && (
          <div style={styles.hint}>
            Start the server first: <code>npm run dev:server</code>
          </div>
        )}
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
            <div
              style={{
                ...styles.timingRow,
                borderTop: "1px solid #21262d",
                marginTop: 4,
                paddingTop: 6,
              }}
            >
              <span style={{ ...styles.timingLabel, fontWeight: 600, color: "#e6edf3" }}>
                Total
              </span>
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
            <div
              style={{
                ...styles.agentValue,
                color:
                  status.agentState === "COMPLETED"
                    ? "#3fb950"
                    : status.agentState === "FAILED"
                      ? "#f85149"
                      : status.agentState === "BLOCKED"
                        ? "#ffa657"
                        : "#e6edf3",
              }}
            >
              {status.agentState}
            </div>
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

      <div style={styles.footer}>
        ISRO PS 26171 · On-device perception · Fail closed
      </div>
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  const good =
    value === "READY" ||
    value === "ACTIVE" ||
    value === "CONNECTED" ||
    value === "OK";

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
      <div style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1.2 }}>
        {value}
      </div>
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

  // Progress banners
  progressIdle: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #21262d",
    background: "#161b22",
    color: "#8b949e",
  },
  progressBusy: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(56, 139, 253, 0.4)",
    background: "rgba(56, 139, 253, 0.12)",
    color: "#79c0ff",
  },
  progressSuccess: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(63, 185, 80, 0.4)",
    background: "rgba(63, 185, 80, 0.12)",
    color: "#3fb950",
  },
  progressError: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(248, 81, 73, 0.4)",
    background: "rgba(248, 81, 73, 0.12)",
    color: "#f85149",
  },
  progressBlocked: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255, 166, 87, 0.4)",
    background: "rgba(255, 166, 87, 0.12)",
    color: "#ffa657",
  },
  progressRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  progressSub: {
    marginTop: 4,
    fontSize: 11,
    opacity: 0.85,
  },
  spinner: {
    display: "inline-block",
    animation: "spin 1s linear infinite",
    fontSize: 14,
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
  input: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #30363d",
    background: "#0d1117",
    color: "#e6edf3",
    fontSize: 13,
    outline: "none",
    marginBottom: 10,
  },
  taskActions: {
    display: "flex",
    gap: 8,
  },
  startBtn: {
    flex: 1,
    padding: "9px 14px",
    borderRadius: 8,
    border: "none",
    background: "linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  demoBtn: {
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #30363d",
    background: "#0d1117",
    color: "#8b949e",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
  },
  hint: {
    marginTop: 8,
    fontSize: 11,
    color: "#f85149",
    opacity: 0.9,
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