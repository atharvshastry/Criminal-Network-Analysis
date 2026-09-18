import React from "react";
import { ENTITY_TYPES, getEntityTypeConfig } from "./entityTypes";

const SEVERITY_LEGEND = [
  { key: "HIGH", label: "High-risk entity", className: "legend-swatch-severity-high" },
  { key: "MEDIUM", label: "Medium-risk entity", className: "legend-swatch-severity-medium" },
  { key: "LOW", label: "Low-risk entity", className: "legend-swatch-severity-low" },
];

export default function NetworkLegend({ types, predictedCount = 0, alertedCount = 0 }) {
  const visibleTypes = types && types.length ? types : ENTITY_TYPES;
  return (
    <div className="network-legend-group">
      <div className="network-legend" aria-label="Entity type legend">
        {visibleTypes.map((type) => (
          <div key={type} className="legend-item">
            <span className="legend-swatch" style={{ backgroundColor: getEntityTypeConfig(type).color }} />
            <span>{type}</span>
          </div>
        ))}
      </div>
      {(predictedCount > 0 || alertedCount > 0) && (
        <div className="network-legend network-legend-status" aria-label="Graph highlight legend">
          {predictedCount > 0 && (
            <div className="legend-item" title="A candidate link the AI inferred from network structure and evidence -- not a confirmed relationship.">
              <span className="legend-swatch legend-swatch-line" />
              <span>AI-predicted link</span>
            </div>
          )}
          {alertedCount > 0 && SEVERITY_LEGEND.map((item) => (
            <div key={item.key} className="legend-item" title="Entity flagged by an investigative alert -- a lead to corroborate, not proof of wrongdoing.">
              <span className={`legend-swatch legend-swatch-ring ${item.className}`} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
