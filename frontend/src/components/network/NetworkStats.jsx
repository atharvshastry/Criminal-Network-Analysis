import React from "react";

export default function NetworkStats({ nodes, edges, flaggedLinks, confidence }) {
  return (
    <div className="network-stats" aria-label="Network statistics">
      <div>
        <span>Nodes</span>
        <strong>{nodes.length}</strong>
      </div>
      <div>
        <span>Edges</span>
        <strong>{edges.length}</strong>
      </div>
      <div>
        <span>Flagged links</span>
        <strong>{flaggedLinks}</strong>
      </div>
      <div>
        <span>Avg. confidence</span>
        <strong>{confidence}%</strong>
      </div>
    </div>
  );
}
