import React from "react";

export default function EvidencePanel({ records = [], loading = false, onTrace }) {
  return (
    <section className="info-section evidence-section">
      <div className="section-heading-row">
        <span className="section-label">Evidence</span>
        <span className="panel-tag">{records.length}</span>
      </div>
      {loading ? <p className="neutral-copy">Loading evidence...</p> : records.length === 0 ? (
        <p className="neutral-copy">No evidence records are available for this synthetic dataset.</p>
      ) : (
        <div className="evidence-list">
          {records.map((record) => (
            <div className="evidence-record" key={record.id}>
              <strong>{record.type || "Record"}</strong>
              <span>{record.source || "Source unavailable"}</span>
              <span>{record.timestamp || "Timestamp unavailable"}</span>
              <span>Confidence {Math.round((record.confidence || 0) * 100)}%</span>
              <span className="evidence-integrity">{record.hash_status || record.integrity_status || "Integrity unavailable"}</span>
              {(record.entity_id || record.relationship_id) && <button type="button" className="inline-link" onClick={() => onTrace?.(record)}>Trace in Graph</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}