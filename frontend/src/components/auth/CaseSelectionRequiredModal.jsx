import React from "react";

export default function CaseSelectionRequiredModal({ onGoBack }) {
  return (
    <div className="case-selection-backdrop" role="presentation">
      <section className="case-selection-modal" role="dialog" aria-modal="true" aria-labelledby="case-selection-title">
        <div className="case-selection-header">
          <span className="case-selection-indicator" aria-hidden="true">!</span>
          <h2 id="case-selection-title">Case selection required</h2>
        </div>
        <p className="case-selection-message">Please select a case first.</p>
        <p className="case-selection-copy">Select a case from the Dashboard before opening this Senior Officer feature.</p>
        <div className="case-selection-actions">
          <button type="button" className="secondary-button" onClick={onGoBack}>Go Back</button>
        </div>
      </section>
    </div>
  );
}