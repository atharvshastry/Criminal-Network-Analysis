import React from "react";

function normalizeConfidence(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if (numericValue >= 0 && numericValue <= 1) {
    return numericValue * 100;
  }

  if (numericValue > 1 && numericValue <= 100) {
    return numericValue;
  }

  return null;
}

function formatConfidence(value) {
  const percent = normalizeConfidence(value);
  if (percent === null) {
    return "Confidence unavailable";
  }
  return `${Math.round(percent)}%`;
}

export default function SearchResults({ result, nodes = [], onFocusResult }) {
  if (!result || result.isSemanticResult === false) {
    return null;
  }

  const hasMeaningfulContent =
    Array.isArray(result.results) && result.results.some((item) => item && (item.entity_id || item.entity_name || item.relationship_id || item.connected_entity_id)) ||
    Array.isArray(result.entities) && result.entities.some((entity) => entity && (entity.id || entity.name || entity.label)) ||
    Array.isArray(result.relationships) && result.relationships.some((relationship) => relationship && (relationship.id || relationship.source || relationship.target)) ||
    Array.isArray(result.connected_entities) && result.connected_entities.some((entity) => entity && (entity.id || entity.name || entity.label));

  if (!hasMeaningfulContent || result.status !== "SUCCESS") {
    return null;
  }

  const nodeById = nodes.reduce((index, node) => {
    index[node.id] = node;
    return index;
  }, {});

  const relationships = Array.isArray(result.relationships) ? result.relationships : [];
  const matchedEntities = Array.isArray(result.entities) ? result.entities : [];
  const connectedEntities = Array.isArray(result.connected_entities) ? result.connected_entities : [];
  const resultItems = Array.isArray(result.results) && result.results.length > 0 ? result.results : [];
  const intentType = result.intent?.type || result.intent || "GENERAL_SEARCH";
  const confidenceValue = result.confidence?.score ?? result.confidence ?? result.summary?.confidence ?? null;
  const confidenceText = formatConfidence(confidenceValue);

  const blankState = result.status === "NO_MATCH" || result.status === "NO_CASE" || result.status === "ERROR" || result.status === "NO_PATH";

  return (
    <section className="search-results" aria-live="polite">
      <div className="search-results-header">
        <div>
          <div className="entity-type">Investigation Search</div>
          <h3>Analysis result</h3>
        </div>
        <span className="panel-tag">{intentType}</span>
      </div>

      <p className="search-results-query">“{result.query || "Natural-language network query"}”</p>

      {result.status === "SUCCESS" && (
        <p className="search-results-confidence">
          Search confidence: {confidenceText}
          {result.confidence?.level ? ` — ${result.confidence.level}` : ""}
        </p>
      )}

      {result.timeline_filter && (
        <p className="search-results-confidence">
          Timeline: {result.timeline_filter} {result.timeline?.length ? `(${result.timeline.length} matching events)` : "(no timestamped records available)"}
        </p>
      )}

      {result.timeline_message && <p className="search-message">{result.timeline_message}</p>}

      {result.status === "AMBIGUOUS" ? (
        <p className="search-message">Multiple matching entities found. Select an entity to continue.</p>
      ) : blankState ? (
        <p className="search-message">{result.message || "No relevant matches for this investigation query."}</p>
      ) : null}

      {result.status === "SUCCESS" && (
        <>
          <div className="search-results-summary">
            <span>Semantic match</span>
            <strong>{result.summary?.entity_count ?? matchedEntities.length ?? 0} entities</strong>
            <strong>{result.summary?.relationship_count ?? relationships.length ?? 0} relationships</strong>
          </div>

          {resultItems.length > 0 ? (
            <div className="search-result-list">
              {resultItems.map((item, index) => {
                const targetEntityName = item.connected_entity_name || "Related entity";
                const sourceEntityName = item.entity_name || nodeById[item.entity_id]?.label || item.entity_id || "Entity";
                const targetEntityId = item.connected_entity_id || item.entity_id;
                const relationshipType = item.relationship_type || "DIRECT_CONNECTION";
                const resultConfidence = formatConfidence(item.confidence ?? result.summary?.confidence ?? 0.0);

                return (
                  <div className="search-result-item search-result-target" key={`${item.relationship_id || item.entity_id || index}-${index}`}>
                    <div className="search-result-body">
                      <div className="match-label-row">
                        <span className="match-label">MATCHED ENTITY</span>
                        <span className="match-value">{sourceEntityName}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">ENTITY TYPE</span>
                        <span className="match-value">{item.entity_type || "UNKNOWN"}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">RELATIONSHIP</span>
                        <span className="match-value">{relationshipType}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">CONNECTED TO</span>
                        <span className="match-value">{targetEntityName}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">CONFIDENCE</span>
                        <span className="match-value success">{resultConfidence}</span>
                      </div>
                      <div className="match-reason">
                        <span className="match-label">WHY MATCHED</span>
                        <p>{item.reason || "The query matches relevant entities and relationship context in this case network."}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="secondary-button focus-button"
                      onClick={() => onFocusResult?.({
                        entity_id: item.entity_id,
                        relationship_id: item.relationship_id,
                        connected_entity_id: item.connected_entity_id,
                        relationship_type: item.relationship_type,
                        source: item.entity_id,
                        target: item.connected_entity_id,
                      })}
                    >
                      FOCUS IN GRAPH
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="search-result-list">
              {relationships.length > 0 ? (
                relationships.map((relationship) => (
                  <div className="search-result-item" key={relationship.id}>
                    <div className="search-result-body">
                      <div className="match-label-row">
                        <span className="match-label">MATCHED ENTITY</span>
                        <span className="match-value">{nodeById[relationship.source]?.label || relationship.source}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">ENTITY TYPE</span>
                        <span className="match-value">{nodeById[relationship.source]?.type || "UNKNOWN"}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">RELATIONSHIP</span>
                        <span className="match-value">{relationship.type || "DIRECT_CONNECTION"}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">CONNECTED TO</span>
                        <span className="match-value">{nodeById[relationship.target]?.label || relationship.target}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">CONFIDENCE</span>
                        <span className="match-value success">{formatConfidence(relationship.confidence ?? relationship.score ?? null)}</span>
                      </div>
                      <div className="match-reason">
                        <span className="match-label">WHY MATCHED</span>
                        <p>The query matches the relevant communication or relationship path in this network.</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="secondary-button focus-button"
                      onClick={() => onFocusResult?.({
                        entity_id: relationship.source,
                        relationship_id: relationship.id,
                        connected_entity_id: relationship.target,
                        relationship_type: relationship.type,
                        source: relationship.source,
                        target: relationship.target,
                      })}
                    >
                      FOCUS IN GRAPH
                    </button>
                  </div>
                ))
              ) : (
                matchedEntities.map((entity) => (
                  <div className="search-result-item" key={entity.id}>
                    <div className="search-result-body">
                      <div className="match-label-row">
                        <span className="match-label">MATCHED ENTITY</span>
                        <span className="match-value">{entity.name || entity.id}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">ENTITY TYPE</span>
                        <span className="match-value">{entity.type || "UNKNOWN"}</span>
                      </div>
                      <div className="match-label-row">
                        <span className="match-label">CONFIDENCE</span>
                        <span className="match-value success">{formatConfidence(entity.score ?? null)}</span>
                      </div>
                      <div className="match-reason">
                        <span className="match-label">WHY MATCHED</span>
                        <p>The entity is relevant to the investigation query and appears in the current case graph.</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="secondary-button focus-button"
                      onClick={() => onFocusResult?.({ entity_id: entity.id, source: entity.id, target: null })}
                    >
                      FOCUS IN GRAPH
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          <div className="search-subsection">
            <div className="section-label">MATCHED ENTITIES</div>
            <p className="subsection-copy">{matchedEntities.length || connectedEntities.length || 0} entities identified</p>
            <div className="search-entity-list">
              {(matchedEntities.length ? matchedEntities : connectedEntities).map((entity) => (
                <button
                  key={entity.id}
                  type="button"
                  className="search-entity-item"
                  onClick={() => onFocusResult?.({ entity_id: entity.id, source: entity.id, target: null })}
                >
                  <span>{entity.name || entity.label || entity.id}</span>
                  <small>{entity.type || "UNKNOWN"}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="search-subsection">
            <div className="section-label">MATCHED RELATIONSHIPS</div>
            <p className="subsection-copy">{relationships.length} relationships identified</p>
            <div className="search-relationship-list">
              {relationships.map((relationship) => (
                <div className="relationship-card" key={relationship.id}>
                  <div className="relationship-line">
                    <span>{nodeById[relationship.source]?.label || relationship.source}</span>
                    <span className="relationship-arrow">→</span>
                    <strong>{relationship.type || "DIRECT_CONNECTION"}</strong>
                    <span className="relationship-arrow">→</span>
                    <span>{nodeById[relationship.target]?.label || relationship.target}</span>
                  </div>
                  <div className="relationship-meta">Confidence: {formatConfidence(relationship.confidence ?? relationship.score ?? null)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="search-explanation">
            <span className="section-label">MATCHED BECAUSE</span>
            <span>✓ Identified {matchedEntities.length || connectedEntities.length || 0} relevant entities</span>
            <span>✓ Found {relationships.length} relevant relationship{relationships.length === 1 ? "" : "s"}</span>
            <span>✓ Semantic match for the investigation query</span>
            <span>
              {confidenceValue === null || confidenceValue === undefined ? "• Relationship confidence unavailable" : `✓ Search confidence: ${confidenceText}`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
