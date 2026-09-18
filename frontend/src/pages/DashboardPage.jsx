import React from "react";
import { NavLink } from "react-router-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import CaseSelectionRequiredModal from "../components/auth/CaseSelectionRequiredModal";
import useAuth from "../hooks/useAuth";
import {
  fetchAlerts,
  fetchCases,
  fetchDashboard,
  fetchEvidence,
  fetchNetwork,
  postAuditLog,
} from "../services/api";

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <div className="muted-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

const SENIOR_FEATURE_IDS = new Set([
  "senior-command",
  "ai-investigation-summary",
  "evidence-verification",
]);

function formatTimestamp(rawTimestamp) {
  if (!rawTimestamp) return "—";
  try {
    const date = new Date(rawTimestamp);
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  } catch {
    return rawTimestamp;
  }
}

export default function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const caseId = searchParams.get("caseId") || "";
  const seniorFeature = searchParams.get("seniorFeature") || "";
  const { user, role } = useAuth();
  const isSenior = role === "senior";
  const [data, setData] = React.useState(null);
  const [caseOptions, setCaseOptions] = React.useState([]);
  const [inventoryStats, setInventoryStats] = React.useState({
    totalCases: null,
    highPriorityCases: null,
  });
  const [caseAlerts, setCaseAlerts] = React.useState([]);
  const [caseNetwork, setCaseNetwork] = React.useState(null);
  const [caseEvidence, setCaseEvidence] = React.useState([]);
  const [evidenceLoading, setEvidenceLoading] = React.useState(false);
  const [evidenceError, setEvidenceError] = React.useState("");
  const [evidenceRequestKey, setEvidenceRequestKey] = React.useState(0);
  const [verificationState, setVerificationState] = React.useState({});
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let ignore = false;

    setData(null);
    setError("");

    fetchCases()
      .then((cases) => {
        if (!ignore) {
          setCaseOptions(cases);
          setInventoryStats({
            totalCases: cases.length,
            highPriorityCases: cases.filter((caseItem) => String(caseItem.priority || "").trim().toLowerCase() === "high").length,
          });
        }
      })
      .catch(() => {
        if (!ignore) {
          setCaseOptions([]);
          setInventoryStats({ totalCases: 0, highPriorityCases: 0 });
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  React.useEffect(() => {
    let ignore = false;

    setData(null);
    setError("");

    fetchDashboard(caseId)
      .then((dashboard) => {
        if (!ignore) {
          setData(dashboard);
        }
      })
      .catch(() => {
        if (!ignore) {
          setData({
            case_id: caseId || null,
            case_title: null,
            active_cases: 0,
            entities: 0,
            relationships: 0,
            alerts: 0,
            high_priority_cases: 0,
            high_priority: false,
          });
          setError("Unable to load case intelligence.");
        }
      });

    return () => {
      ignore = true;
    };
  }, [caseId]);

  React.useEffect(() => {
    let ignore = false;

    if (!caseId) {
      setCaseAlerts([]);
      setCaseNetwork(null);
      setCaseEvidence([]);
      setEvidenceLoading(false);
      setEvidenceError("");
      return;
    }

    setCaseEvidence([]);
    setEvidenceLoading(true);
    setEvidenceError("");

    Promise.all([
      fetchAlerts(caseId),
      fetchNetwork(caseId),
      fetchEvidence(caseId),
    ])
      .then(([alerts, network, evidencePayload]) => {
        if (ignore) return;
        setCaseAlerts(Array.isArray(alerts) ? alerts : []);
        setCaseNetwork(network || null);
        setCaseEvidence(Array.isArray(evidencePayload?.records) ? evidencePayload.records : []);
        setEvidenceLoading(false);
      })
      .catch(() => {
        if (ignore) return;
        setCaseAlerts([]);
        setCaseNetwork(null);
        setCaseEvidence([]);
        setEvidenceLoading(false);
        setEvidenceError("Unable to load supporting evidence.");
      });

    return () => {
      ignore = true;
    };
  }, [caseId, evidenceRequestKey]);

  React.useEffect(() => {
    if (!caseId || !user || !isSenior) {
      return;
    }

    const action = "VIEW_CASE";
    postAuditLog({
      officer_id: user.id,
      role: user.role,
      action,
      case_id: caseId,
      target_id: caseId,
    }).catch(() => undefined);
  }, [caseId, user, isSenior]);

  React.useEffect(() => {
    if (!caseId || !user || !isSenior) {
      return;
    }

    postAuditLog({
      officer_id: user.id,
      role: user.role,
      action: "GENERATE_AI_SUMMARY",
      case_id: caseId,
      target_id: caseId,
    }).catch(() => undefined);
  }, [caseId, user, isSenior]);

  const handleCaseChange = (event) => {
    const nextCaseId = event.target.value;
    if (user && nextCaseId) {
      postAuditLog({
        officer_id: user.id,
        role: user.role,
        action: "SELECT_CASE",
        case_id: nextCaseId,
        target_id: nextCaseId,
      }).catch(() => undefined);
    }
    setSearchParams(nextCaseId ? { caseId: nextCaseId } : {});
  };

  const closeCaseSelectionWarning = () => {
    setSearchParams(caseId ? { caseId } : {});
  };

  const selectedCase = caseOptions.find((item) => item.id === caseId);
  const selectedCaseTitle = selectedCase?.title || data?.case_title;
  const caseContext = caseId && selectedCaseTitle
    ? `${caseId} — ${selectedCaseTitle}`
    : "Select a case to begin investigation.";

  const seniorCommandStats = React.useMemo(() => {
    const totalCases = caseOptions.length;
    const highPriorityCases = caseOptions.filter((caseItem) => String(caseItem.priority || "").trim().toLowerCase() === "high").length;
    const criticalAlerts = caseAlerts.filter((alert) => String(alert.severity || "").trim().toUpperCase() === "HIGH").length;
    const casesRequiringReview = caseOptions.filter((caseItem) => String(caseItem.status || "").trim().toLowerCase() === "under review").length;
    const evidenceRequiringVerification = caseEvidence.length;

    return {
      totalCases,
      highPriorityCases,
      criticalAlerts,
      casesRequiringReview,
      evidenceRequiringVerification,
    };
  }, [caseOptions, caseAlerts, caseEvidence]);

  const selectedAlert = React.useMemo(() => {
    if (!caseAlerts.length) return null;
    return caseAlerts.find((alert) => String(alert.severity || "").trim().toUpperCase() === "HIGH") || caseAlerts[0];
  }, [caseAlerts]);

  const summaryObservationList = React.useMemo(() => {
    const observations = [];
    if (caseAlerts.some((alert) => String(alert.severity || "").trim().toUpperCase() === "HIGH")) {
      observations.push("High-severity alert activity is present in the selected case.");
    }
    if (data?.relationships) {
      observations.push(`The current case network contains ${data.relationships} relationships for review.`);
    }
    if (caseNetwork?.nodes?.length) {
      const topEntities = [...(caseNetwork.nodes || [])]
        .sort((a, b) => Number(b.centrality || 0) - Number(a.centrality || 0))
        .slice(0, 3)
        .map((node) => node.label || node.id);
      if (topEntities.length) {
        observations.push(`Important network entities include ${topEntities.join(", ")}.`);
      }
    }
    if (!observations.length) {
      observations.push("The selected case has no high-severity alerts in the current demo dataset.");
    }
    return observations;
  }, [caseAlerts, data, caseNetwork]);

  const importantEntities = React.useMemo(() => {
    if (!caseNetwork?.nodes?.length) return [];
    return [...caseNetwork.nodes]
      .sort((a, b) => Number(b.centrality || 0) - Number(a.centrality || 0))
      .slice(0, 3)
      .map((node) => ({
        id: node.id,
        label: node.label || node.id,
        type: node.type || "UNKNOWN",
      }));
  }, [caseNetwork]);

  const handleEvidenceVerification = (alert) => {
    if (!user || !caseId) return;
    const nextStatus = verificationState[alert.id] === "VERIFIED" ? "REQUIRES REVIEW" : "VERIFIED";
    setVerificationState((current) => ({ ...current, [alert.id]: nextStatus }));
    postAuditLog({
      officer_id: user.id,
      role: user.role,
      action: "VERIFY_EVIDENCE",
      case_id: caseId,
      target_id: alert.id,
    }).catch(() => undefined);
  };

  const handleAlertView = (alert) => {
    if (!user || !caseId) return;
    postAuditLog({
      officer_id: user.id,
      role: user.role,
      action: "VIEW_ALERT",
      case_id: caseId,
      target_id: alert.id,
    }).catch(() => undefined);
  };

  const handleEvidenceView = (record) => {
    if (!record?.id || !caseId) return;
    navigate(`/evidence?caseId=${encodeURIComponent(caseId)}&evidenceId=${encodeURIComponent(record.id)}`);
  };

  const handleEvidenceInventory = () => {
    if (!caseId) return;
    navigate(`/evidence?caseId=${encodeURIComponent(caseId)}`);
  };

  return (
    <AppLayout title="Dashboard" subtitle="Operational overview" actions={(
      <label className="network-case-selector" htmlFor="dashboard-case-select">
        <span>SELECT CASE</span>
        <select id="dashboard-case-select" value={caseId} onChange={handleCaseChange}>
          <option value="">Select Case</option>
          {caseOptions.map((item) => (
            <option key={item.id} value={item.id}>{item.id} — {item.title}</option>
          ))}
        </select>
      </label>
    )}>
      <div className="panel-copy dashboard-case-context">{caseContext}</div>
      {error ? <div className="state-panel error">{error}</div> : null}
      {!data ? <div className="state-panel">Loading case intelligence...</div> : null}
      {isSenior && SENIOR_FEATURE_IDS.has(seniorFeature) && !caseId && (
        <CaseSelectionRequiredModal onGoBack={closeCaseSelectionWarning} />
      )}
      <section className="stats-grid">
        <StatCard label="Total Cases" value={inventoryStats.totalCases ?? "—"} />
        <StatCard label="Entities" value={data?.entities ?? 0} />
        <StatCard label="Relationships" value={data?.relationships ?? 0} />
        <StatCard label="Alerts" value={data?.alerts ?? 0} />
      </section>

      {isSenior && (
        <section id="senior-command" className="panel">
          <div className="panel-header">
            <h2>SENIOR OFFICER COMMAND</h2>
            <span className="panel-tag">SENIOR OFFICER</span>
          </div>
          {!caseId ? (
            <p className="panel-copy">Select a case to begin Senior Officer analysis.</p>
          ) : (
            <div className="stats-grid">
              <StatCard label="Total Cases" value={seniorCommandStats.totalCases} />
              <StatCard label="High Priority Cases" value={seniorCommandStats.highPriorityCases} />
              <StatCard label="Critical Alerts" value={seniorCommandStats.criticalAlerts} />
              <StatCard label="Cases Requiring Review" value={seniorCommandStats.casesRequiringReview} />
              <StatCard label="Evidence Requiring Verification" value={seniorCommandStats.evidenceRequiringVerification} />
            </div>
          )}
        </section>
      )}

      {isSenior && caseId && (
        <>
          <section id="ai-investigation-summary" className="panel">
            <div className="panel-header">
              <h2>AI INVESTIGATION SUMMARY</h2>
              <span className="panel-tag">AI SUMMARY</span>
            </div>
            <div className="investigation-summary">
              <div className="panel-copy"><strong>{caseId}</strong> — {selectedCaseTitle}</div>
              <div className="stats-grid" style={{ marginTop: "16px" }}>
                <div className="summary-field"><span className="muted-label">Status</span><strong>{selectedCase?.status || "—"}</strong></div>
                <div className="summary-field"><span className="muted-label">Priority</span><strong>{selectedCase?.priority || "—"}</strong></div>
                <div className="summary-field"><span className="muted-label">Entities</span><strong>{data?.entities ?? 0}</strong></div>
                <div className="summary-field"><span className="muted-label">Relationships</span><strong>{data?.relationships ?? 0}</strong></div>
                <div className="summary-field"><span className="muted-label">Alerts</span><strong>{data?.alerts ?? 0}</strong></div>
                <div className="summary-field"><span className="muted-label">High severity alerts</span><strong>{caseAlerts.filter((alert) => String(alert.severity || "").trim().toUpperCase() === "HIGH").length}</strong></div>
              </div>
              <div className="panel-copy" style={{ marginTop: "18px" }}>
                <strong>Key observations:</strong>
                <ul className="reason-list">
                  {summaryObservationList.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div className="summary-disclaimer">AI-generated investigative summary. Verify findings against source evidence.</div>
            </div>
          </section>

          <section id="evidence-verification" className="panel">
            <div className="panel-header">
              <h2>EVIDENCE VERIFICATION</h2>
              <span className="panel-tag">VERIFY EVIDENCE</span>
            </div>
            {!selectedAlert ? (
              <p className="panel-copy">No alert data is available for the selected case.</p>
            ) : (
              <div className="panel-grid two-up">
                <div className="panel">
                  <div className="panel-header">
                    <h2>Alert</h2>
                    <span className={`status-badge ${String(selectedAlert.severity || "medium").toLowerCase()}`}>{selectedAlert.severity}</span>
                  </div>
                  <p className="panel-copy"><strong>{selectedAlert.id}</strong> — {selectedAlert.title}</p>
                  <div className="detail-grid compact">
                    <div><span className="detail-label">Type</span><strong>{selectedAlert.title}</strong></div>
                    <div><span className="detail-label">Related entity</span><strong>{selectedAlert.entity_id}</strong></div>
                    <div><span className="detail-label">AI confidence</span><strong>{Math.round((selectedAlert.score || 0) * 100)}%</strong></div>
                    <div><span className="detail-label">Status</span><strong>{verificationState[selectedAlert.id] || "REQUIRES REVIEW"}</strong></div>
                  </div>
                  <div className="action-row">
                    <button type="button" className="secondary-button" onClick={() => handleEvidenceVerification(selectedAlert)}>
                      {verificationState[selectedAlert.id] === "VERIFIED" ? "Mark as Requires Review" : "Mark as Verified"}
                    </button>
                  </div>
                  <div className="panel-copy" style={{ marginTop: "12px" }}>
                    AI scores are indicators. Verify supporting evidence before making decisions.
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <h2>Supporting evidence</h2>
                      <span className="panel-copy evidence-count">
                        {evidenceLoading ? "Loading evidence..." : `${caseEvidence.length} record${caseEvidence.length === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    {!evidenceLoading && caseEvidence.length > 0 && (
                      <button type="button" className="inline-link" onClick={handleEvidenceInventory}>
                        VIEW ALL EVIDENCE
                      </button>
                    )}
                  </div>
                  {evidenceLoading ? (
                    <div className="state-panel">Loading evidence...</div>
                  ) : evidenceError ? (
                    <div className="state-panel error">
                      <p>{evidenceError}</p>
                      <button type="button" className="secondary-button" onClick={() => setEvidenceRequestKey((current) => current + 1)}>
                        RETRY
                      </button>
                    </div>
                  ) : caseEvidence.length ? (
                    <div className="evidence-list">
                      {caseEvidence.map((record) => (
                        <div key={record.id} className="evidence-record">
                          <div className="evidence-meta-row">
                            <strong>{record.id}</strong>
                            <span className="status-badge warning">{String(record.verification_status || "PENDING").replace("_", " ")}</span>
                          </div>
                          <strong>{record.type || "Evidence record"}</strong>
                          <span>{record.title || record.summary || "Evidence record"}</span>
                          <span>{formatTimestamp(record.timestamp)}</span>
                          <span>Confidence: {Math.round((Number(record.confidence) || 0) * 100)}%</span>
                          <span className="evidence-integrity">Integrity: {record.hash_status || record.integrity_status || "HASH UNVERIFIED"}</span>
                          {record.details && (
                            <div className="evidence-detail-preview">
                              {Object.entries(record.details).map(([key, value]) => (
                                <span key={`${record.id}-${key}`}><strong>{key.replace(/_/g, " ")}:</strong> {Array.isArray(value) ? value.join(", ") : String(value)}</span>
                              ))}
                            </div>
                          )}
                          <button type="button" className="inline-link" onClick={() => handleEvidenceView(record)}>VIEW EVIDENCE</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="panel-copy">No evidence records are currently available for this case.</p>
                  )}
                </div>
              </div>
            )}
          </section>

        </>
      )}

      {!isSenior && (
        <section className="panel-grid two-up">
          <div className="panel">
            <div className="panel-header">
              <h2>Network intelligence</h2>
            </div>
            <p className="panel-copy">
              Explore people, phones, vehicles, locations and organizations as a connected investigative graph.
            </p>
            <NavLink className="primary-button" to="/network">
              Open Network Explorer
            </NavLink>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2>Case priority</h2>
            </div>
            <div className="metric-value emphasis">{inventoryStats.highPriorityCases ?? "—"}</div>
            <p className="panel-copy">Cases currently marked high priority in the case inventory.</p>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Recommended workflow</h2>
        </div>
        <div className="workflow-list">
          <span>1</span>
          <span>Open CASE-001</span>
          <span>2</span>
          <span>Review P001 profile</span>
          <span>3</span>
          <span>Trace graph connections</span>
          <span>4</span>
          <span>Assess alert explanation</span>
        </div>
      </section>
    </AppLayout>
  );
}
