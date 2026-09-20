import React from "react";

export default function InvestigationSummary({ entity, relationships = [], alerts = [], evidence = [] }) {
  return (
    <section className="investigation-summary">
      <div className="panel-header-row">
        <div>
          <div className="entity-type">Investigation Summary</div>
          <h3>{entity?.label || entity?.name || "Current selection"}</h3>
        </div>
      </div>
      {!entity ? <p className="neutral-copy">Select a node or run an investigation query to build a factual summary.</p> : (
        <div className="summary-grid compact summary-stats">
          <div className="summary-field"><span className="detail-label">Key connections</span><strong>{new Set(relationships.map((item) => item.relatedEntityId)).size}</strong></div>
          <div className="summary-field"><span className="detail-label">Relationships</span><strong>{relationships.length}</strong></div>
          <div className="summary-field"><span className="detail-label">Alerts</span><strong>{alerts.length}</strong></div>
          <div className="summary-field"><span className="detail-label">Evidence</span><strong>{evidence.length}</strong></div>
          <p className="summary-disclaimer">AI-generated results are investigative indicators, not proof.</p>
        </div>
      )}
    </section>
  );
}