import React from "react";
import { NavLink } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import useCase from "../hooks/useCase";
import { fetchEntities, fetchEntityDetail } from "../services/api";

export default function EntityDetailPage({ id }) {
  const { caseId } = useCase();
  const [entity, setEntity] = React.useState(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let ignore = false;
    setEntity(null);
    setError("");

    const loadEntity = caseId
      ? fetchEntities(caseId).then((entities) => entities.find((item) => item.id === id) || null)
      : fetchEntityDetail(id);

    loadEntity
      .then((selectedEntity) => {
        if (!ignore) {
          if (selectedEntity) {
            setEntity(selectedEntity);
          } else {
            setError("Entity not found in the selected case.");
          }
        }
      })
      .catch(() => {
        if (!ignore) {
          setError("Unable to load entity.");
        }
      });

    return () => {
      ignore = true;
    };
  }, [caseId, id]);

  if (!entity) {
    return (
      <AppLayout title="Entity detail" subtitle="Profile analysis">
        <div className="state-panel">{error || "Loading entity record..."}</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={entity.name} subtitle={entity.id} actions={<NavLink className="primary-button compact" to="/network">View in network</NavLink>}>
      <section className="panel">
        <div className="entity-type">{entity.type}</div>
        <h2>{entity.name}</h2>

        <div className="stats-grid two-up">
          <div className="stat-card">
            <div className="muted-label">Confidence</div>
            <div className="metric-value small">{Math.round(entity.confidence * 100)}%</div>
          </div>
          <div className="stat-card">
            <div className="muted-label">Community</div>
            <div className="metric-value small">{entity.community}</div>
          </div>
          <div className="stat-card">
            <div className="muted-label">Centrality</div>
            <div className="metric-value small">{entity.centrality}</div>
          </div>
          <div className="stat-card">
            <div className="muted-label">Entity ID</div>
            <div className="metric-value small">{entity.id}</div>
          </div>
        </div>
      </section>
    </AppLayout>
  );
}
