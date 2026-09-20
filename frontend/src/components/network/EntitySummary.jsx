import React from "react";

export default function EntitySummary({ entity }) {
  if (!entity) {
    return null;
  }

  return (
    <section className="info-section">
      <div className="section-heading-row">
        <span className="section-label">Entity</span>
      </div>

      <div className="entity-summary-grid">
        <div className="summary-field">
          <span className="detail-label">Name</span>
          <strong>{entity.label || entity.name || entity.id}</strong>
        </div>
        <div className="summary-field">
          <span className="detail-label">Entity ID</span>
          <strong>{entity.id}</strong>
        </div>
        <div className="summary-field">
          <span className="detail-label">Type</span>
          <strong>{entity.type}</strong>
        </div>
        <div className="summary-field">
          <span className="detail-label">Confidence</span>
          <strong>{Math.round((entity.confidence || 0) * 100)}%</strong>
        </div>
        <div className="summary-field">
          <span className="detail-label">Community</span>
          <strong>{entity.community}</strong>
        </div>
        <div className="summary-field">
          <span className="detail-label">Centrality</span>
          <strong>{entity.centrality}</strong>
        </div>
      </div>
    </section>
  );
}
