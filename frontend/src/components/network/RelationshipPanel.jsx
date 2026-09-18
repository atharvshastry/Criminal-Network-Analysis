import React from "react";
import EvidencePanel from "./EvidencePanel";

export default function RelationshipPanel({ edge, sourceNode, targetNode, phoneNode, phoneNumber, onPhoneSelect, evidence = [], evidenceLoading = false, onTraceEvidence }) {
  if (!edge) {
    return (
      <div className="side-panel empty">
        <h3>Relationship details</h3>
        <p>Select an edge to inspect the link between entities.</p>
      </div>
    );
  }

  return (
    <div className="side-panel">
      <div className="panel-header-row">
        <div>
          <div className="entity-type">Relationship</div>
          <h3>{edge.type}</h3>
        </div>
        <span className="panel-tag">{edge.id}</span>
      </div>

      <div className="detail-grid compact">
        <div>
          <span className="detail-label">Source</span>
          <strong>{sourceNode?.label || sourceNode?.id || edge.source}</strong>
        </div>
        <div>
          <span className="detail-label">Target</span>
          <strong>{targetNode?.label || targetNode?.id || edge.target}</strong>
        </div>
        {edge.type === "CALL" && (
          <div>
            <span className="detail-label">Phone number</span>
            {phoneNumber ? (
              <button type="button" className="relationship-phone-link" onClick={() => onPhoneSelect?.(phoneNode)}>
                {phoneNumber}
              </button>
            ) : (
              <strong>Not available in current dataset</strong>
            )}
          </div>
        )}
        <div>
          <span className="detail-label">Confidence</span>
          <strong>{Math.round((edge.confidence || 0) * 100)}%</strong>
        </div>
      </div>
      <EvidencePanel records={evidence} loading={evidenceLoading} onTrace={onTraceEvidence} />
    </div>
  );
}
