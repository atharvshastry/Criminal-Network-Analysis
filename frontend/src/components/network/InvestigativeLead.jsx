import React from "react";

export default function InvestigativeLead({ alert, fallbackDescription }) {
  if (!alert) {
    return (
      <section className="info-section lead-section">
        <div className="section-heading-row">
          <span className="section-label">Entity Summary</span>
        </div>
        <p className="neutral-copy">
          {fallbackDescription || "No current investigative lead for this entity."}
        </p>
      </section>
    );
  }

  return (
    <section className="info-section lead-section">
      <div className="section-heading-row">
        <span className="section-label">Investigative Lead</span>
        <span className={`lead-badge ${alert.severity?.toLowerCase() || "medium"}`}>{alert.severity}</span>
      </div>

      <div className="lead-header">
        <strong>{alert.title}</strong>
        <span>{Math.round((alert.score || 0) * 100)}%</span>
      </div>

      <ul className="lead-reasons">
        {alert.reasons?.map((reason) => <li key={reason}>{reason}</li>) || <li>AI-generated indicator available.</li>}
      </ul>
    </section>
  );
}
