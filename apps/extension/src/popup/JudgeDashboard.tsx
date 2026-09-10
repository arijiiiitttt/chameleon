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

type Tab = "home" | "privacy" | "activity";

export function JudgeDashboard(): React.ReactElement {
  const [status, setStatus] = useState<AgentStatusMessage>(initialStatus);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [intent, setIntent] = useState(DEMO_INTENT);
  const [isStarting, setIsStarting] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
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

  // Auto-jump to the Privacy tab whenever a run finishes, so the judge
  // sees the metrics that matter without an extra click. Purely a UX
  // nicety layered on top of existing state - no logic changed.
  const prevTerminalRef = useRef(false);
  useEffect(() => {
    const nowTerminal = TERMINAL_STATES.has(status.agentState);
    if (nowTerminal && !prevTerminalRef.current) {
      setTab("privacy");
    }
    prevTerminalRef.current = nowTerminal;
  }, [status.agentState]);

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
  let ProgressIcon: (() => React.ReactElement) | null = null;
  if (isBusy || isStarting) {
    progressBannerStyle = styles.progressBusy ?? {};
    progressText = stageLabel;
  } else if (status.agentState === "COMPLETED") {
    progressBannerStyle = styles.progressSuccess ?? {};
    progressText = "Task completed successfully";
    ProgressIcon = CheckIcon;
  } else if (status.agentState === "FAILED") {
    progressBannerStyle = styles.progressError ?? {};
    progressText = "Task failed";
    ProgressIcon = AlertIcon;
  } else if (status.agentState === "BLOCKED") {
    progressBannerStyle = styles.progressBlocked ?? {};
    progressText = "Task blocked by privacy / policy";
    ProgressIcon = ShieldIcon;
  }

  const sensitiveTotal = status.privacy.sensitiveDetected;
  const badgeCount = isTerminal && sensitiveTotal > 0 ? sensitiveTotal : 0;

  return (
    <div style={styles.app}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.logoRow}>
            <div style={styles.logo}>
              <ChameleonMark />
            </div>
            <div>
              <div style={styles.title}>Chameleon</div>
              <div style={styles.subtitle}>Privacy-Preserving Visual Agent</div>
            </div>
          </div>
          <button onClick={pullStatus} style={styles.refreshBtn} title="Refresh status">
            <RefreshIcon spinning={isRefreshing} />
          </button>
        </div>

        {/* Connection Banner */}
        <div
          style={{
            ...styles.banner,
            background: serverConnected
              ? "rgba(63, 185, 80, 0.10)"
              : "rgba(248, 81, 73, 0.10)",
            borderColor: serverConnected
              ? "rgba(63, 185, 80, 0.28)"
              : "rgba(248, 81, 73, 0.28)",
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
              opacity: 0.7,
              textTransform: "capitalize",
            }}
          >
            {status.server.provider || "—"}
          </span>
        </div>

        {/* ── Live Progress / Result Banner ── */}
        <div style={progressBannerStyle}>
          <div style={styles.progressRow}>
            {(isBusy || isStarting) && <SpinnerIcon />}
            {ProgressIcon && <ProgressIcon />}
            <span style={{ fontWeight: 600, fontSize: 13 }}>{progressText}</span>
          </div>
          {(isBusy || isStarting) && (
            <div style={styles.progressSub}>Agent is working — do not close this tab</div>
          )}
          {isTerminal && status.agentState === "COMPLETED" && (
            <div style={styles.progressSub}>All actions finished. Check the page for results.</div>
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

        {/* ── Tab content ── */}
        <div style={styles.tabContent}>
          {tab === "home" && (
            <HomeTab
              intent={intent}
              setIntent={setIntent}
              handleKeyDown={handleKeyDown}
              handleStartTask={handleStartTask}
              isBusy={isBusy}
              isStarting={isStarting}
              isTerminal={isTerminal}
              canStart={canStart}
              serverConnected={serverConnected}
              status={status}
            />
          )}
          {tab === "privacy" && <PrivacyTab status={status} />}
          {tab === "activity" && <ActivityTab status={status} />}
        </div>

        <div style={styles.footer}>ISRO PS 26171 · On-device perception · Fail closed</div>
      </div>

      {/* ── Bottom tab bar ── */}
      <div style={styles.tabBar}>
        <TabButton
          active={tab === "home"}
          label="Home"
          icon={<HomeIcon active={tab === "home"} />}
          onClick={() => setTab("home")}
        />
        <TabButton
          active={tab === "privacy"}
          label="Privacy"
          icon={<ShieldTabIcon active={tab === "privacy"} />}
          badge={badgeCount > 0 ? badgeCount : undefined}
          onClick={() => setTab("privacy")}
        />
        <TabButton
          active={tab === "activity"}
          label="Activity"
          icon={<ActivityIcon active={tab === "activity"} />}
          onClick={() => setTab("activity")}
        />
      </div>
    </div>
  );
}

/* ───────────────────────── Tabs ───────────────────────── */

function HomeTab({
  intent,
  setIntent,
  handleKeyDown,
  handleStartTask,
  isBusy,
  isStarting,
  isTerminal,
  canStart,
  serverConnected,
  status,
}: {
  intent: string;
  setIntent: (v: string) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleStartTask: () => void;
  isBusy: boolean;
  isStarting: boolean;
  isTerminal: boolean;
  canStart: boolean;
  serverConnected: boolean;
  status: AgentStatusMessage;
}) {
  return (
    <>
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <PlayIcon />
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

      {/* Agent Card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <AgentIcon />
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
    </>
  );
}

function PrivacyTab({ status }: { status: AgentStatusMessage }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <ShieldIcon />
        <span style={styles.cardTitle}>Privacy</span>
      </div>
      <div style={styles.metricsGrid}>
        <MetricBox label="Sensitive" value={status.privacy.sensitiveDetected} color="#c9a6ff" />
        <MetricBox label="Redacted" value={status.privacy.redacted} color="#79c0ff" />
        <MetricBox label="Blocked" value={status.privacy.blocked} color="#ffa657" />
        <MetricBox
          label="Raw PII Sent"
          value={status.privacy.rawPiiSent}
          color={status.privacy.rawPiiSent === 0 ? "#3fb950" : "#f85149"}
          highlight
        />
      </div>
      <div style={styles.privacyNote}>
        Sensitive fields are detected and redacted locally, before anything ever
        leaves the browser.
      </div>
    </div>
  );
}

function ActivityTab({ status }: { status: AgentStatusMessage }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <BoltIcon />
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
  );
}

/* ───────────────────────── Small components ───────────────────────── */

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
        background: good ? "rgba(63, 185, 80, 0.10)" : "rgba(139, 148, 158, 0.10)",
        borderColor: good ? "rgba(63, 185, 80, 0.26)" : "rgba(139, 148, 158, 0.22)",
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

function TabButton({
  active,
  label,
  icon,
  badge,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactElement;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={styles.tabButton}>
      <span style={styles.tabIconWrap}>
        {icon}
        {badge !== undefined && <span style={styles.tabBadge}>{badge}</span>}
      </span>
      <span
        style={{
          ...styles.tabLabel,
          color: active ? "#ab8bff" : "#6e7681",
        }}
      >
        {label}
      </span>
    </button>
  );
}

/* ───────────────────────── Icons (inline SVG, no emoji) ───────────────────────── */

function ChameleonMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2c-3.5 0-6 2.5-6 6 0 2 1 3.2 1 4.5 0 1-1 1.5-1 3 0 2.5 2 4.5 4.5 4.5.8 0 1.5-.2 2-.5"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="15" cy="7.5" r="1.1" fill="white" />
      <path d="M18 12c1.8.6 3 1.8 3 3.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      style={spinning ? { animation: "chameleon-spin 0.8s linear infinite" } : undefined}
    >
      <path
        d="M20 11A8 8 0 1 0 19 15"
        stroke="#e6edf3"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M20 5v6h-6" stroke="#e6edf3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ animation: "chameleon-spin 0.8s linear infinite" }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M7 4v16l13-8L7 4Z" fill="#8b949e" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="8" width="16" height="11" rx="2.5" stroke="#8b949e" strokeWidth="1.6" />
      <path d="M12 8V4M9 4h6" stroke="#8b949e" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9" cy="13.5" r="1.2" fill="#8b949e" />
      <circle cx="15" cy="13.5" r="1.2" fill="#8b949e" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="#8b949e" />
    </svg>
  );
}

function HomeIcon({ active }: { active: boolean }) {
  const c = active ? "#ab8bff" : "#6e7681";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M4 11.5 12 4l8 7.5" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldTabIcon({ active }: { active: boolean }) {
  const c = active ? "#ab8bff" : "#6e7681";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 3 5 6v5.5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3Z" stroke={c} strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

function ActivityIcon({ active }: { active: boolean }) {
  const c = active ? "#ab8bff" : "#6e7681";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M3 12h4l2.5-7 5 14L17 12h4" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ───────────────────────── Styles ───────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    flexDirection: "column",
    background: "#0a0d12",
    minHeight: "100%",
  },
  container: {
    padding: "14px 14px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    flex: 1,
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
    width: 34,
    height: 34,
    borderRadius: 10,
    background: "linear-gradient(135deg, #7b3fe4 0%, #ab8bff 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 10px rgba(123, 63, 228, 0.35)",
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.2,
    color: "#f0f6fc",
  },
  subtitle: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 1,
  },
  refreshBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "none",
    background: "#161b22",
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
    border: "1px solid #1c2129",
    background: "#12161d",
    color: "#8b949e",
  },
  progressBusy: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(171, 139, 255, 0.35)",
    background: "rgba(171, 139, 255, 0.10)",
    color: "#c9a6ff",
  },
  progressSuccess: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(63, 185, 80, 0.35)",
    background: "rgba(63, 185, 80, 0.10)",
    color: "#3fb950",
  },
  progressError: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(248, 81, 73, 0.35)",
    background: "rgba(248, 81, 73, 0.10)",
    color: "#f85149",
  },
  progressBlocked: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255, 166, 87, 0.35)",
    background: "rgba(255, 166, 87, 0.10)",
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

  tabContent: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
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
    background: "#12161d",
    border: "1px solid #1c2129",
    borderRadius: 14,
    padding: "12px 14px",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginBottom: 10,
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
    border: "1px solid #232833",
    background: "#0a0d12",
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
    borderRadius: 10,
    border: "none",
    background: "linear-gradient(135deg, #7b3fe4 0%, #ab8bff 100%)",
    color: "#100716",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  demoBtn: {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #232833",
    background: "#0a0d12",
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
    borderRadius: 10,
    border: "1px solid",
    padding: "10px 10px",
    textAlign: "center",
  },
  privacyNote: {
    marginTop: 10,
    fontSize: 11,
    lineHeight: 1.5,
    color: "#8b949e",
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
    paddingBottom: 2,
  },

  tabBar: {
    display: "flex",
    borderTop: "1px solid #1c2129",
    background: "#0a0d12",
    padding: "6px 6px 8px",
    position: "sticky",
    bottom: 0,
  },
  tabButton: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    padding: "6px 0 2px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
  },
  tabIconWrap: {
    position: "relative",
    display: "flex",
  },
  tabBadge: {
    position: "absolute",
    top: -4,
    right: -6,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    background: "#ab8bff",
    color: "#100716",
    fontSize: 9,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 3px",
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: 600,
  },
};