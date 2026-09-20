import React from "react";
import AppLayout from "../components/layout/AppLayout";
import useCase from "../hooks/useCase";
import { fetchAlerts } from "../services/api";

export default function AlertsPage() {
  const { caseId } = useCase();
  const [items, setItems] = React.useState([]);

  React.useEffect(() => {
    fetchAlerts(caseId)
      .then(setItems)
      .catch(() => setItems([]));
  }, [caseId]);

  return (
    <AppLayout title="Alerts" subtitle="Investigative indicators">
      {caseId ? (
        <div className="panel-copy">Case {caseId} · {items.length} alerts</div>
      ) : (
        <div className="state-panel">Select a case from the top bar to view its alerts.</div>
      )}
      <section className="alert-list">
        {items.map((alert) => (
          <article key={alert.id} className="alert-card">
            <div className="alert-header">
              <span className={`status-badge ${alert.severity.toLowerCase()}`}>{alert.severity}</span>
              <h3>{alert.title}</h3>
              <span className="score-pill">{Math.round(alert.score * 100)}%</span>
            </div>
            <div className="muted-label">Entity: {alert.entity_id}</div>
            <ul className="reason-list">
              {alert.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </AppLayout>
  );
}
