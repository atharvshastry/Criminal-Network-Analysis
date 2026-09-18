import React from "react";

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
          {relationships.map((relationship) => (
            <tr key={relationship.id || `${relationship.type}-${relationship.relatedEntityId}`}>
              <td>{relationship.type}</td>
              <td>{relationship.relatedEntityLabel || relationship.relatedEntityId}</td>
              <td>{Math.round((relationship.confidence || 0) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
