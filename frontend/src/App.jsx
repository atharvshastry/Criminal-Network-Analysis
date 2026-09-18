
import React from "react";
import { Route, Routes, useParams } from "react-router-dom";
import ProtectedRoute from "./components/auth/ProtectedRoute";
import SeniorFeatureRoute from "./components/auth/SeniorFeatureRoute";

import DashboardPage from "./pages/DashboardPage";
import CasesPage from "./pages/CasesPage";
import CaseDetailPage from "./pages/CaseDetailPage";
import NetworkExplorer from "./pages/NetworkExplorer";
import EntitiesPage from "./pages/EntitiesPage";
import EntityDetailPage from "./pages/EntityDetailPage";
import AlertsPage from "./pages/AlertsPage";
import EvidencePage from "./pages/EvidencePage";
import TimelinePage from "./pages/TimelinePage";
import LoginPage from "./pages/LoginPage";
import ViewActivityPage from "./pages/ViewActivityPage";

function CaseRoute() {
  const { id } = useParams();
  return <CaseDetailPage id={id} />;
}

function EntityRoute() {
  const { id } = useParams();
  return <EntityDetailPage id={id} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/cases" element={<CasesPage />} />
        <Route path="/cases/:id" element={<CaseRoute />} />
        <Route path="/network" element={<NetworkExplorer />} />
        <Route path="/entities" element={<EntitiesPage />} />
        <Route path="/entities/:id" element={<EntityRoute />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="/view-activity" element={<ViewActivityPage />} />
        <Route path="/timeline" element={<TimelinePage />} />
        <Route path="/senior-command" element={<SeniorFeatureRoute sectionId="senior-command" />} />
        <Route path="/ai-investigation-summary" element={<SeniorFeatureRoute sectionId="ai-investigation-summary" />} />
        <Route path="/evidence-verification" element={<SeniorFeatureRoute sectionId="evidence-verification" />} />
        <Route path="*" element={<DashboardPage />} />
      </Route>
    </Routes>
  );
}
