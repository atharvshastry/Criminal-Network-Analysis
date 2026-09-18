import React from "react";
import { NavLink } from "react-router-dom";
import EntitySummary from "./EntitySummary";
import RelationshipList from "./RelationshipList";
import InvestigativeLead from "./InvestigativeLead";
import EvidencePanel from "./EvidencePanel";

export default function EntityInvestigationPanel({
  entity,
  relationshipRows = [],
  alert,
  onClose,
  evidence = [],
  evidenceLoading = false,
  onTraceEvidence,
  caseId,
}) {
  if (!entity) {
    return (
      <div className="side-panel empty">
        <div className="panel-header-row">
          <div>
            <div className="entity-type">Investigation</div>
            <h3>Panel</h3>
          </div>
        </div>
        <p>Select a node to inspect the entity and its surrounding network.</p>
      </div>
    );
  }

  const entityName = entity.label || entity.name || entity.id;
  const connectedEntityCount = new Set(relationshipRows.map((relationship) => relationship.relatedEntityId)).size;

  return (
    <div className="side-panel investigation-panel">
      <div className="panel-header-row panel-top-row">
        <div>
          <div className="entity-type">{entity.type}</div>
          <h3>{entityName}</h3>
        </div>
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close investigation panel">
          ×
        </button>
      </div>

      <EntitySummary entity={entity} />

      <section className="info-section">
        <div className="section-heading-row">
          <span className="section-label">Network Position</span>
        </div>

        <div className="summary-grid compact">
          <div className="summary-field">
            <span className="detail-label">Connected entities</span>
            <strong>{connectedEntityCount}</strong>
          </div>
          <div className="summary-field">
            <span className="detail-label">Direct relationships</span>
            <strong>{relationshipRows.length}</strong>
          </div>
          <div className="summary-field">
            <span className="detail-label">Centrality score</span>
            <strong>{entity.centrality}</strong>
          </div>
          <div className="summary-field">
            <span className="detail-label">Community ID</span>
            <strong>{entity.community}</strong>
          </div>
        </div>
      </section>

      <section className="info-section">
        <div className="section-heading-row">
          <span className="section-label">Relationships</span>
        </div>
        <RelationshipList relationships={relationshipRows} />
      </section>

      <InvestigativeLead alert={alert} />

      <EvidencePanel records={evidence} loading={evidenceLoading} onTrace={onTraceEvidence} />

      <div className="action-row">
        <NavLink className="inline-link" to={`/entities/${entity.id}?entityId=${entity.id}`} state={{ entityId: entity.id }}>
          View Entity
        </NavLink>
        <NavLink className="inline-link" to={`/alerts?entityId=${entity.id}`} state={{ entityId: entity.id }}>
          View Alerts
        </NavLink>
        <NavLink className="inline-link" to={`/evidence?caseId=${encodeURIComponent(caseId || "")}`}>
          View Evidence
        </NavLink>
      </div>
    </div>
  );
}
