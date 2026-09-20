import React from "react";
import { getRelationshipLabel } from "./NetworkGraph";

export default function RelationshipList({ relationships }) {
  if (!relationships.length) {
    return (
      <div className="empty-row">
        <span>No direct relationships recorded for this entity.</span>
      </div>
    );
  }

  return (
    <div className="relationship-table-wrap">
      <table className="relationship-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Related entity</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {relationships.map((relationship) => {
            const isPredicted = relationship.status === "predicted";
            const rowKey = relationship.id || `${relationship.type}-${relationship.relatedEntityId}`;
            return (
              <React.Fragment key={rowKey}>
                <tr>
                  <td>
                    {getRelationshipLabel(relationship.type)}
                    {isPredicted && <span className="lead-badge medium relationship-predicted-badge inline">AI predicted</span>}
                  </td>
                  <td>{relationship.relatedEntityLabel || relationship.relatedEntityId}</td>
                  <td>{Math.round((relationship.confidence || 0) * 100)}%</td>
                </tr>
                {relationship.evidenceText && (
                  <tr className="relationship-description-row">
                    <td colSpan={3}>
                      {isPredicted ? "Why this was suggested: " : ""}
                      {relationship.evidenceText}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
