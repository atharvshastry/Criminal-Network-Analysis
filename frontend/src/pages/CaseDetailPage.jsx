import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import { fetchAlerts, fetchCaseDetail, fetchEntities } from "../services/api";

function CaseHeader({ caseItem }) {
  return (
    <div className="case-detail-header">
      <div>
        <div className="eyebrow">Case investigation</div>
        <h2>{caseItem.title}</h2>
      </div>
      <span className={`status-badge ${caseItem.priority.toLowerCase()}`}>{caseItem.priority}</span>
    </div>
  );
}

function CaseStats({ caseItem }) {
  return (
    <div className="stats-grid three-up">
      <div className="stat-card">
        <div className="muted-label">Case ID</div>
        <div className="metric-value small">{caseItem.id}</div>
      </div>
      <div className="stat-card">
        <div className="muted-label">Status</div>
        <div className="metric-value small">{caseItem.status}</div>
      </div>
      <div className="stat-card">
        <div className="muted-label">Priority</div>
        <div className="metric-value small">{caseItem.priority}</div>
      </div>
      <div className="stat-card">
        <div className="muted-label">Entities</div>
        <div className="metric-value small">{caseItem.entities}</div>
      </div>
      <div className="stat-card">
        <div className="muted-label">Relationships</div>
        <div className="metric-value small">{caseItem.relationships}</div>
      </div>
      <div className="stat-card">
        <div className="muted-label">Alerts</div>
        <div className="metric-value small">{caseItem.alerts}</div>
      </div>
    </div>
  );
}

function CaseActions({ navigate, caseId }) {
  return (
    <div className="action-row">
      <button type="button" className="primary-button" onClick={() => navigate(`/network?caseId=${encodeURIComponent(caseId)}`)}>Explore Network</button>
      <button type="button" className="secondary-button" onClick={() => navigate(`/alerts?caseId=${encodeURIComponent(caseId)}`)}>View Alerts</button>
      <button type="button" className="secondary-button" onClick={() => navigate(`/entities?caseId=${encodeURIComponent(caseId)}`)}>View Entities</button>
    </div>
  );
}

function ImportantEntities({ entities }) {
  if (!entities || entities.length === 0) {
    return <div className="state-panel empty">No case-linked entities available in current demo data.</div>;
  }

  return (
    <div className="entity-list">
      {entities.map((entity) => (
        <div key={entity.id} className="entity-chip-card">
          <div className="entity-chip-type">{entity.type}</div>
          <div className="entity-chip-name">{entity.name}</div>
          <div className="entity-chip-meta">{entity.id} • confidence {Math.round(entity.confidence * 100)}%</div>
        </div>
      ))}
    </div>
  );
}

function InvestigativeLeads({ leads }) {
  if (!leads || leads.length === 0) {
    return <div className="state-panel empty">No case-linked alerts available in current demo data.</div>;
  }

  return (
    <div className="lead-list">
      {leads.map((lead) => (
        <article key={lead.id} className="lead-card">
          <div className="lead-header">
            <span className={`status-badge ${lead.severity.toLowerCase()}`}>{lead.severity}</span>
            <span className="score-pill">{Math.round(lead.score * 100)}%</span>
          </div>
          <h3>{lead.title}</h3>
          <div className="muted-label">Entity: {lead.entity_id}</div>
          <ul className="reason-list">
            {lead.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

export default function CaseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [caseItem, setCaseItem] = React.useState(null);
  const [importantEntities, setImportantEntities] = React.useState([]);
  const [caseAlerts, setCaseAlerts] = React.useState([]);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;

    async function loadCase() {
      setLoading(true);
      setError("");

      try {
        const [detail, entityList, alertList] = await Promise.all([
          fetchCaseDetail(id),
          fetchEntities(id),
          fetchAlerts(id),
        ]);

        if (!active) {
          return;
        }

        const rankedEntities = [...entityList]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 4);

        setCaseItem(detail);
        setImportantEntities(rankedEntities);
        setCaseAlerts(Array.isArray(alertList) ? alertList : []);

        if (!detail) {
          setError("Case not found.");
        }

        if (alertList && alertList.length > 0 && !detail) {
          setError("Case not found.");
        }
      } catch (err) {
        if (active) {
          setError(err.message || "Unable to load case details.");
          setCaseItem(null);
          setImportantEntities([]);
          setCaseAlerts([]);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    if (id) {
      loadCase();
    }

    return () => {
      active = false;
    };
  }, [id]);

  if (loading) {
    return (
      <AppLayout title="Case detail" subtitle="Case review">
        <div className="state-panel">Loading case record…</div>
      </AppLayout>
    );
  }

  if (error || !caseItem) {
    return (
      <AppLayout title="Case detail" subtitle="Case review">
        <div className="state-panel error">{error || "Case record unavailable."}</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={caseItem.title} subtitle={`Case ${caseItem.id}`}>
      <section className="panel">
        <CaseHeader caseItem={caseItem} />
        <div className="case-overview-body">
          <CaseStats caseItem={caseItem} />
          <CaseActions navigate={navigate} caseId={caseItem.id} />
        </div>
      </section>

      <section className="panel-grid two-up">
        <div className="panel">
          <div className="panel-header">
            <h2>Important entities</h2>
          </div>
          <ImportantEntities entities={importantEntities} />
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Investigative leads</h2>
          </div>
          <InvestigativeLeads leads={caseAlerts} />
        </div>
      </section>
    </AppLayout>
  );
}
