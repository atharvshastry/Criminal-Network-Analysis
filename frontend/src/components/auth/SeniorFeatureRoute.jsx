import React from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import useAuth from "../../hooks/useAuth";

export default function SeniorFeatureRoute({ sectionId }) {
  const [searchParams] = useSearchParams();
  const { role } = useAuth();
  const caseId = searchParams.get("caseId") || "";
  const query = new URLSearchParams();

  if (role !== "senior") {
    return <Navigate to="/" replace />;
  }

  if (caseId) {
    query.set("caseId", caseId);
  } else {
    query.set("seniorFeature", sectionId);
  }

  return <Navigate to={`/?${query.toString()}#${sectionId}`} replace />;
}