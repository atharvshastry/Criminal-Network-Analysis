import React from "react";
import AssistantPanel from "./AssistantPanel";

// Quick-access launcher: a button that opens the AI Investigation Assistant
// (Graph RAG) in a modal, for use on the Dashboard. The full interactive
// experience also lives at /assistant (see AIAssistantPage.jsx, linked from
// the sidebar) -- both mount the same AssistantPanel, just in different
// chrome, and keep independent conversation state.
export default function AIInvestigationAssistant() {
  const [open, setOpen] = React.useState(false);

  const openAssistant = () => setOpen(true);
  const closeAssistant = () => setOpen(false);

  return (
    <>
      <button type="button" className="primary-button assistant-launch-button" onClick={openAssistant}>
        AI Investigation Assistant
      </button>

      {open && (
        <div className="assistant-modal-backdrop" role="presentation" onClick={closeAssistant}>
          <section
            className="assistant-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="assistant-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="assistant-modal-header">
              <div>
                <div className="entity-type">Graph RAG</div>
                <h2 id="assistant-modal-title">AI Investigation Assistant</h2>
              </div>
              <button type="button" className="assistant-close-button" aria-label="Close" onClick={closeAssistant}>
                ×
              </button>
            </div>

            <AssistantPanel />
          </section>
        </div>
      )}
    </>
  );
}
