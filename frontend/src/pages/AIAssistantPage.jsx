import React from "react";
import AppLayout from "../components/layout/AppLayout";
import AssistantPanel from "../components/assistant/AssistantPanel";

// Dedicated, full-page AI Investigation Assistant (Graph RAG), reachable
// from the sidebar. Same underlying panel as the Dashboard's quick-access
// modal (AIInvestigationAssistant.jsx), just given the full content area
// instead of a modal, for a more comfortable back-and-forth conversation.
export default function AIAssistantPage() {
  return (
    <AppLayout title="AI Investigation Assistant" subtitle="Graph RAG — evidence-grounded Q&A over the case graph">
      <section className="panel assistant-page">
        <AssistantPanel />
      </section>
    </AppLayout>
  );
}
