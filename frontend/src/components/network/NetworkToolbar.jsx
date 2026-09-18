import React from "react";

const EXAMPLE_QUERIES = [
  "How does Aarav communicate with Kabir?",
  "Who communicates with Aarav?",
  "Who is connected to Aarav?",
  "Show Aarav's relationships.",
];

export default function NetworkToolbar({
  searchTerm,
  onSearchChange,
  onSearchSubmit,
  onFitGraph,
  onZoomIn,
  onZoomOut,
  onResetView,
  onClearSearch,
  onSuggestionSelect,
  suggestions = [],
  searchMessage,
  semanticLoading,
  currentZoom,
  isDisabled,
  showPredicted,
  onTogglePredicted,
  predictedCount = 0,
}) {
  return (
    <div className="network-toolbar">
      <div className="toolbar-actions">
        <button type="button" className="toolbar-button" onClick={onFitGraph} disabled={isDisabled}>
          Fit Graph
        </button>
        <button type="button" className="toolbar-button" onClick={onZoomIn} disabled={isDisabled}>
          Zoom In
        </button>
        <button type="button" className="toolbar-button" onClick={onZoomOut} disabled={isDisabled}>
          Zoom Out
        </button>
        <button type="button" className="toolbar-button" onClick={onResetView} disabled={isDisabled}>
          Reset View
        </button>
        <span className="zoom-readout" aria-live="polite">
          Zoom {Math.round((currentZoom || 0) * 100)}%
        </span>
        {predictedCount > 0 && (
          <label className="predicted-toggle" title="AI-predicted links are candidate leads, not confirmed relationships.">
            <input
              type="checkbox"
              checked={showPredicted}
              onChange={(event) => onTogglePredicted?.(event.target.checked)}
              disabled={isDisabled}
            />
            <span>Show AI-predicted links ({predictedCount})</span>
          </label>
        )}
      </div>

      <form className="toolbar-search" onSubmit={onSearchSubmit}>
        <div className="search-input-wrap">
          <div className="toolbar-search-header">
            <span className="entity-type">Investigation Search</span>
            <span className="muted-label">Natural-language network query</span>
          </div>
          <div className="investigation-search-row">
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Ask a natural-language investigation question..."
              aria-label="Search entity or investigation question"
              aria-describedby="network-search-hint"
            />
            <button type="submit" className="toolbar-button primary" disabled={isDisabled}>
              {semanticLoading ? "Analyzing..." : "Analyze"}
            </button>
          </div>
          {suggestions.length > 0 && (
            <div className="search-suggestions" role="listbox" aria-label="Entity suggestions">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="search-suggestion"
                  onClick={() => onSuggestionSelect(suggestion)}
                >
                  <strong>{suggestion.id}</strong>
                  <span>{suggestion.label}</span>
                </button>
              ))}
            </div>
          )}
          <span id="network-search-hint" className="search-hint">Exact: P001 or Aarav Mehta. Natural language: who communicates with Aarav?</span>
          {searchMessage && <span className="search-message" role="status">{searchMessage}</span>}
          <div className="example-query-list">
            {EXAMPLE_QUERIES.map((example) => (
              <button key={example} type="button" className="example-query" onClick={() => onSearchChange(example)}>
                {example}
              </button>
            ))}
          </div>
        </div>
        {searchTerm.trim() && (
          <button type="button" className="toolbar-button" onClick={onClearSearch} disabled={isDisabled}>
            Clear
          </button>
        )}
      </form>
    </div>
  );
}
