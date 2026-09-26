import React from "react";
import AppLayout from "../components/layout/AppLayout";
import useCase from "../hooks/useCase";
import useAuth from "../hooks/useAuth";
import { fetchEntities, generateReport, postAuditLog } from "../services/api";
import { downloadReportPdf } from "../utils/reportPdf";

// Report Generation (see backend/app/reports.py + POST /api/reports/generate).
// Reuses this case's existing network/evidence/alert/timeline data and the
// AI Investigation Assistant's LLM integration (graph_rag.py) -- this page
// only requests, previews, prints, and exports that already-assembled
// report. There is no separate report data pipeline on the frontend either.

function formatDateTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function pct(value) {
  if (value === null || value === undefined) return "N/A";
  return `${Math.round(Number(value) * 100)}%`;
}

function priorityBadgeTone(priority) {
  const value = (priority || "").toLowerCase();
  if (value === "high" || value === "critical") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function SectionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="report-section-icon-svg">
      <path d="M6 2h9l5 5v15H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M15 2v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12h6M9 15.5h6M9 8.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ReportSection({ title, meta, children }) {
  return (
    <div className="report-section">
      <div className="report-section-heading">
        <span className="report-section-icon"><SectionIcon /></span>
        <h3>{title}</h3>
        {meta && <span className="report-section-meta">{meta}</span>}
      </div>
      <div className="report-section-body">{children}</div>
    </div>
  );
}

function EmptyNote({ children }) {
  return <p className="panel-copy report-empty-note">{children}</p>;
}

export default function ReportsPage() {
  const { caseId, cases } = useCase();
  const { user } = useAuth();
  const [entities, setEntities] = React.useState([]);
  const [entityId, setEntityId] = React.useState("");
  const [report, setReport] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState("");

  const selectedCase = cases.find((item) => item.id === caseId);

  React.useEffect(() => {
    setReport(null);
    setError("");
    setEntityId("");
    if (!caseId) {
      setEntities([]);
      return undefined;
    }
    let ignore = false;
    fetchEntities(caseId)
      .then((payload) => {
        if (!ignore) setEntities(Array.isArray(payload) ? payload : []);
      })
      .catch(() => {
        if (!ignore) setEntities([]);
      });
    return () => {
      ignore = true;
    };
  }, [caseId]);

  const handleGenerate = async () => {
    if (!caseId || loading) return;
    setLoading(true);
    setError("");
    try {
      const payload = await generateReport(caseId, entityId || null, user?.name);
      setReport(payload);
      if (user) {
        postAuditLog({
          officer_id: user.id,
          role: user.role,
          action: "GENERATE_REPORT",
          case_id: caseId,
          target_id: payload?.report_id,
        }).catch(() => undefined);
      }
    } catch (err) {
      setReport(null);
      setError(err?.message || "Unable to generate the investigation report.");
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = async () => {
    if (!report || downloading) return;
    setDownloading(true);
    try {
      await downloadReportPdf(report);
    } catch {
      setError("Unable to generate the PDF for download. Try Print Report instead.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <AppLayout title="Reports" subtitle="Investigation report generator">
      <section className="panel report-toolbar">
        <div className="panel-header">
          <h2>Report generator</h2>
          {report && <span className="status-badge low">PREVIEW READY</span>}
        </div>

        {!caseId ? (
          <p className="panel-copy">Select a case from the top bar to generate an investigation report.</p>
        ) : (
          <>
            <p className="panel-copy">
              Generate a structured investigation report from <strong>{caseId}</strong>
              {selectedCase?.title ? ` — ${selectedCase.title}` : ""}'s existing graph, evidence, alerts,
              timeline, and AI Investigation Assistant data.
            </p>
            <div className="report-toolbar-row">
              <label className="network-case-selector">
                <span>Focus entity (optional)</span>
                <select value={entityId} onChange={(event) => setEntityId(event.target.value)}>
                  <option value="">Most connected entity (default)</option>
                  {entities.map((entity) => (
                    <option key={entity.id} value={entity.id}>{entity.id} — {entity.name}</option>
                  ))}
                </select>
              </label>
              <div className="report-toolbar-actions">
                <button type="button" className="primary-button compact" onClick={handleGenerate} disabled={loading}>
                  {loading ? "GENERATING..." : "GENERATE REPORT"}
                </button>
                <button type="button" className="secondary-button" onClick={handlePrint} disabled={!report}>
                  PRINT REPORT
                </button>
                <button type="button" className="secondary-button" onClick={handleDownload} disabled={!report || downloading}>
                  {downloading ? "PREPARING PDF..." : "DOWNLOAD REPORT"}
                </button>
              </div>
            </div>
          </>
        )}

        {error && <div className="state-panel error report-toolbar-error">{error}</div>}
      </section>

      {loading && !report && <div className="state-panel">Assembling the investigation report from case data...</div>}

      {!loading && caseId && !report && !error && (
        <div className="state-panel empty">Click "Generate Report" to build a report from this case's current data.</div>
      )}

      {report && (
        <section className="panel report-document report-print-area">
          <div className="report-header">
            <div>
              <div className="eyebrow">TraceX / Investigation Report</div>
              <h2 className="report-header-title">{report.case?.id}</h2>
              <p className="report-header-subtitle">{report.case?.title}</p>
            </div>
            <div className="report-header-meta">
              <span className={`status-badge ${priorityBadgeTone(report.case?.priority)}`}>
                {(report.case?.priority || "UNKNOWN").toUpperCase()}
              </span>
              <span className="report-header-timestamp">
                {(report.case?.status || "STATUS UNKNOWN").toUpperCase()} · {formatDateTime(report.generated_at)}
              </span>
            </div>
          </div>

          {/* 10. AI-generated executive summary -- based only on retrieved TraceX data */}
          <ReportSection title="Executive Summary" meta={report.executive_summary?.generated ? "AI-GENERATED" : undefined}>
            {report.executive_summary?.generated && report.executive_summary?.text ? (
              <p className="report-prose">{report.executive_summary.text}</p>
            ) : (
              <EmptyNote>{report.executive_summary?.message || "Insufficient evidence found in the available case data to generate an executive summary."}</EmptyNote>
            )}
          </ReportSection>

          {/* 2. Investigated person/entity */}
          <ReportSection title="Investigated Entity">
            {report.primary_entity ? (
              <div className="entity-chip-card">
                <div className="entity-chip-type">{report.primary_entity.type}</div>
                <div className="entity-chip-name">{report.primary_entity.name} ({report.primary_entity.id})</div>
                <div className="entity-chip-meta">
                  Centrality {report.primary_entity.centrality ?? "N/A"} · Confidence {pct(report.primary_entity.confidence)}
                </div>
              </div>
            ) : (
              <EmptyNote>No entities are available in this case's network graph to investigate.</EmptyNote>
            )}
          </ReportSection>

          {/* 3. Key connected entities */}
          <ReportSection title="Key Connected Entities">
            {report.key_entities?.length ? (
              <div className="report-entity-grid">
                {report.key_entities.map((entity) => (
                  <div className="entity-chip-card" key={entity.id}>
                    <div className="entity-chip-type">{entity.type}</div>
                    <div className="entity-chip-name">{entity.name}</div>
                    <div className="entity-chip-meta">{entity.id}</div>
                    {entity.relationship_to_primary && (
                      <div className="entity-chip-meta report-entity-relation">
                        via {entity.relationship_to_primary.type}{" "}
                        <span className={`status-badge ${entity.relationship_to_primary.status === "confirmed" ? "low" : "medium"}`}>
                          {entity.relationship_to_primary.status.toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyNote>No directly connected entities were found for the investigated entity.</EmptyNote>
            )}
          </ReportSection>

          {/* 4. Important relationship paths */}
          <ReportSection title="Important Relationship Paths">
            {report.connection_paths?.length ? (
              <div className="report-path-list">
                {report.connection_paths.map((path) => (
                  <div className="evidence-record report-path-row" key={path.target_entity_id}>
                    <strong>{path.target_entity_name}</strong>
                    <span className="report-path-chain">
                      {path.path.map((node) => node.name).join("  →  ")}
                    </span>
                    {path.relationship_types?.length > 0 && (
                      <span className="report-path-types">via {path.relationship_types.join(", ")}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyNote>No alert-linked relationship paths were found from the investigated entity.</EmptyNote>
            )}
          </ReportSection>

          {/* 5. Graph/network summary */}
          <ReportSection title="Network Summary">
            <div className="stats-grid three-up report-stats-grid">
              <div className="stat-card">
                <div className="muted-label">Entities</div>
                <div className="metric-value small">{report.network_summary?.entity_count ?? 0}</div>
              </div>
              <div className="stat-card">
                <div className="muted-label">Relationships</div>
                <div className="metric-value small">{report.network_summary?.relationship_count ?? 0}</div>
              </div>
              <div className="stat-card">
                <div className="muted-label">Communities</div>
                <div className="metric-value small">{report.network_summary?.community_count ?? 0}</div>
              </div>
            </div>
            {report.network_summary?.entity_type_breakdown?.length > 0 && (
              <div className="report-chip-row">
                {report.network_summary.entity_type_breakdown.map(([type, count]) => (
                  <span className="report-chip" key={type}>{type} · {count}</span>
                ))}
              </div>
            )}
          </ReportSection>

          {/* 6. Key findings and alerts */}
          <ReportSection title="Key Findings & Alerts" meta={report.alerts?.total ? `${report.alerts.total} total` : undefined}>
            {report.alerts?.records?.length ? (
              <div className="alert-list">
                {report.alerts.records.map((alert) => (
                  <div className="alert-card" key={alert.id}>
                    <div className="alert-header">
                      <h3>{alert.title}</h3>
                      <span className={`status-badge ${priorityBadgeTone(alert.severity)}`}>{(alert.severity || "INFO").toUpperCase()}</span>
                    </div>
                    <div className="panel-copy">Entity: {alert.entity_id} · Score {alert.score ?? "N/A"}</div>
                    {alert.reasons?.length > 0 && (
                      <ul className="reason-list">
                        {alert.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyNote>No alerts are recorded for this case.</EmptyNote>
            )}
          </ReportSection>

          {/* 8. Confirmed vs predicted relationships */}
          <ReportSection title="Confirmed vs Predicted Relationships">
            <div className="report-relationship-split">
              <div>
                <div className="report-relationship-split-heading">
                  <span className="status-badge low">CONFIRMED</span>
                  <span className="report-relationship-count">{report.relationships?.confirmed_total ?? 0} total</span>
                </div>
                {report.relationships?.confirmed?.length ? (
                  <ul className="assistant-evidence-list report-relationship-list">
                    {report.relationships.confirmed.map((rel) => (
                      <li key={rel.id}>{rel.source_name} —[{rel.type}]→ {rel.target_name} ({pct(rel.confidence)})</li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote>No confirmed relationships are recorded for this case.</EmptyNote>
                )}
              </div>
              <div>
                <div className="report-relationship-split-heading">
                  <span className="status-badge medium">PREDICTED / AI-INFERRED</span>
                  <span className="report-relationship-count">{report.relationships?.predicted_total ?? 0} total</span>
                </div>
                {report.relationships?.predicted?.length ? (
                  <ul className="assistant-evidence-list report-relationship-list">
                    {report.relationships.predicted.map((rel) => (
                      <li key={rel.id}>{rel.source_name} —[{rel.type}]→ {rel.target_name} ({pct(rel.confidence)})</li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote>No predicted/AI-inferred relationships are recorded for this case.</EmptyNote>
                )}
              </div>
            </div>
          </ReportSection>

          {/* 7. Supporting evidence */}
          <ReportSection title="Supporting Evidence" meta={report.evidence?.total ? `${report.evidence.total} total` : undefined}>
            {report.evidence?.records?.length ? (
              <div className="evidence-list">
                {report.evidence.records.map((record) => (
                  <div className="evidence-record" key={record.id}>
                    <strong>{record.title}</strong>
                    <span>{record.source} · {formatDateTime(record.timestamp)}</span>
                    <span className="evidence-status-label">{record.verification_status}</span>
                    {record.summary && <span>{record.summary}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyNote>No supporting evidence records are available for this case.</EmptyNote>
            )}
          </ReportSection>

          {/* 9. Investigation timeline */}
          <ReportSection title="Investigation Timeline">
            {report.timeline?.records?.length ? (
              <div className="report-timeline">
                {report.timeline.records.map((event) => (
                  <div className="evidence-record report-timeline-item" key={event.id}>
                    <strong>{formatDateTime(event.timestamp)}</strong>
                    <span>{event.title}</span>
                    {event.description && <span>{event.description}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyNote>No dated timeline events are available for this case.</EmptyNote>
            )}
          </ReportSection>

          {/* 11. Investigation limitations / insufficient evidence */}
          <ReportSection title="Investigation Limitations">
            {report.limitations?.length ? (
              <ul className="report-limitations-list">
                {report.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
              </ul>
            ) : (
              <EmptyNote>No limitations were identified for this report.</EmptyNote>
            )}
          </ReportSection>

          {/* 12. Report generation date and case metadata */}
          <div className="report-footer">
            <span>Report ID: {report.report_id}</span>
            <span>Case: {report.case?.id}</span>
            <span>Generated: {formatDateTime(report.generated_at)}</span>
            <span>By: {report.generated_by}</span>
          </div>
        </section>
      )}
    </AppLayout>
  );
}
