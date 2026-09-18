import React from "react";
import { useNavigate } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import { fetchCases, fetchEntities } from "../services/api";

export default function EntitiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const caseId = searchParams.get("caseId") || "";
  const [items, setItems] = React.useState([]);
  const [caseOptions, setCaseOptions] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const navigate = useNavigate();

  React.useEffect(() => {
    let ignore = false;

    fetchCases()
      .then((cases) => {
        if (!ignore) {
          setCaseOptions(cases);
        }
      })
      .catch(() => {
        if (!ignore) {
          setCaseOptions([]);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  React.useEffect(() => {
    let ignore = false;
    setItems([]);
    setError("");

    if (!caseId) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    fetchEntities(caseId)
      .then((entities) => {
        if (!ignore) {
          setItems(entities);
        }
      })
      .catch(() => {
        if (!ignore) {
          setItems([]);
          setError("Unable to load entities.");
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [caseId]);

  const handleCaseChange = (event) => {
    const nextCaseId = event.target.value;
    setSearchParams(nextCaseId ? { caseId: nextCaseId } : {});
  };

  const selectedCaseTitle = caseOptions.find((item) => item.id === caseId)?.title;

  return (
    <AppLayout title="Entities" subtitle="Entity registry" actions={(
      <label className="network-case-selector" htmlFor="entity-case-select">
        <span>SELECT CASE</span>
        <select id="entity-case-select" value={caseId} onChange={handleCaseChange}>
          <option value="">Select Case</option>
          {caseOptions.map((item) => (
            <option key={item.id} value={item.id}>{item.id} — {item.title}</option>
          ))}
        </select>
      </label>
    )}>
      <section className="panel">
        {loading ? <div className="state-panel">Loading entities...</div> : null}
        {!loading && error ? <div className="state-panel error">{error}</div> : null}
        {!loading && !error && !caseId ? <div className="state-panel">Select a case to view its entities.</div> : null}
        {!loading && !error && caseId && !items.length ? <div className="state-panel">No entities found for this case.</div> : null}
        {!loading && !error && items.length ? (
          <>
            <div className="entity-page-context">{selectedCaseTitle || caseId} · {items.length} entities</div>
            <div className="entity-grid">
              {items.map((entity) => (
                <button key={entity.id} className="entity-card" type="button" onClick={() => navigate(`/entities/${entity.id}?caseId=${encodeURIComponent(caseId)}`)}>
                  <div className="entity-type">{entity.type}</div>
                  <strong>{entity.name}</strong>
                  <div className="entity-meta">{entity.id} · confidence {Math.round(entity.confidence * 100)}%</div>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </AppLayout>
  );
}
