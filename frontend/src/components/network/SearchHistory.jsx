import React from "react";

export default function SearchHistory({ entries = [], onSelect }) {
  if (!entries.length) return null;
  return (
    <section className="search-history">
      <span className="section-label">Recent searches</span>
      <div className="search-history-list">
        {entries.map((entry) => (
          <button type="button" className="search-history-item" key={entry.id} onClick={() => onSelect(entry)}>
            <span>{entry.query}</span>
            <small>{entry.intent}</small>
          </button>
        ))}
      </div>
    </section>
  );
}