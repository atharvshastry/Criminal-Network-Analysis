import React from "react";
import { Navigate } from "react-router-dom";
import useAuth from "../../hooks/useAuth";
import useCase from "../../hooks/useCase";

export default function SeniorFeatureRoute({ sectionId }) {
  const { role } = useAuth();
  const { caseId } = useCase();

  if (role !== "senior") {
    return <Navigate to="/" replace />;
  }

  const query = caseId ? "" : `?seniorFeature=${encodeURIComponent(sectionId)}`;

  return <Navigate to={`/${query}#${sectionId}`} replace />;
}
