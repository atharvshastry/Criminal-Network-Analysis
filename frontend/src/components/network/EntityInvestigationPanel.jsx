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
  crossCaseMatches = [],
  onSwitchCase,
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

  // A node can match more than one entity in the same other case (e.g. both
  // a shared phone number and a shared vehicle) -- group by case so the
  // panel reads as "also in Case X", not one row per matched field.
  const crossCaseByCase = [];
  const seenCaseIds = new Set();
  for (const match of crossCaseMatches) {
    if (seenCaseIds.has(match.case_id)) continue;
    seenCaseIds.add(match.case_id);
    crossCaseByCase.push({
      caseId: match.case_id,
      caseTitle: match.case_title,
      labels: crossCaseMatches.filter((m) => m.case_id === match.case_id).map((m) => m.label),
    });
  }

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

      {crossCaseByCase.length > 0 && (
        <section className="info-section cross-case-section">
          <div className="section-heading-row">
            <span className="section-label">Linked across cases</span>
            <span className="lead-badge medium cross-case-badge">{crossCaseByCase.length} other case{crossCaseByCase.length === 1 ? "" : "s"}</span>
          </div>
          <p className="panel-copy cross-case-note">
            This same {entity.type?.toLowerCase() || "entity"} also shows up in the case(s) below -- a lead worth checking, not a confirmed identity match.
          </p>
          <ul className="cross-case-list">
            {crossCaseByCase.map((match) => (
              <li key={match.caseId} className="cross-case-item">
                <div>
                  <strong>{match.caseTitle}</strong>
                  <span className="cross-case-meta"> — {match.caseId} — as {match.labels.join(", ")}</span>
                </div>
                <button type="button" className="cross-case-switch-button" onClick={() => onSwitchCase?.(match.caseId)}>
                  Open case
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
