import React from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import { fetchCases, fetchEntities, fetchTimeline } from "../services/api";

function formatTimestamp(value) {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function TimelinePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const caseId = searchParams.get("caseId") || "";
  const [cases, setCases] = React.useState([]);
  const [events, setEvents] = React.useState([]);
  const [entityIndex, setEntityIndex] = React.useState({});
  const [loading, setLoading] = React.useState(Boolean(caseId));
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let ignore = false;
    fetchCases()
      .then((payload) => {
        if (!ignore) setCases(payload || []);
      })
      .catch(() => {
        if (!ignore) setCases([]);
      });
    return () => {
      ignore = true;
    };
  }, []);

  React.useEffect(() => {
    let ignore = false;
    setEvents([]);
    setError("");

    if (!caseId) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    Promise.all([fetchTimeline(caseId), fetchEntities(caseId)])
      .then(([timelinePayload, entities]) => {
        if (ignore) return;
        const rawEvents = Array.isArray(timelinePayload?.events) ? timelinePayload.events : [];
        const sorted = [...rawEvents].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        setEvents(sorted);
        setEntityIndex(
          (entities || []).reduce((acc, entity) => {
            acc[entity.id] = entity;
            return acc;
          }, {}),
        );
      })
      .catch(() => {
        if (!ignore) {
          setEvents([]);
          setError("Unable to load the timeline for this case.");
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [caseId]);

  const handleCaseChange = (event) => {
    const nextCaseId = event.target.value;
    setSearchParams(nextCaseId ? { caseId: nextCaseId } : {});
  };

  const selectedCaseTitle = cases.find((item) => item.id === caseId)?.title;

  return (
    <AppLayout
      title="Timeline"
      subtitle="Chronological case events"
      actions={(
        <label className="network-case-selector" htmlFor="timeline-case-select">
          <span>SELECT CASE</span>
          <select id="timeline-case-select" value={caseId} onChange={handleCaseChange}>
            <option value="">Select Case</option>
            {cases.map((item) => (
              <option key={item.id} value={item.id}>{item.id} — {item.title}</option>
            ))}
          </select>
        </label>
      )}
    >
      <section className="panel">
        {!caseId ? (
          <div className="state-panel">Select a case to view its timeline.</div>
        ) : loading ? (
          <div className="state-panel">Loading timeline...</div>
        ) : error ? (
          <div className="state-panel error">{error}</div>
        ) : events.length === 0 ? (
          <div className="state-panel empty">No dated events are available for this case yet.</div>
        ) : (
          <>
            <div className="panel-copy" style={{ marginBottom: "14px" }}>
              <strong>{caseId}</strong> — {selectedCaseTitle || "Case record"} · {events.length} events
            </div>
            <div className="evidence-list">
              {events.map((event) => (
                <div className="evidence-record" key={event.id}>
                  <div className="evidence-meta-row">
                    <strong>{formatTimestamp(event.timestamp)}</strong>
                    {event.source_document_id && (
                      <span className="evidence-status-label">{event.source_document_id}</span>
                    )}
                  </div>
                  <strong>{event.title}</strong>
                  <span>{event.description}</span>
                  {Array.isArray(event.entity_ids) && event.entity_ids.length > 0 && (
                    <div className="document-actions">
                      {event.entity_ids.map((entityId) => {
                        const entity = entityIndex[entityId];
                        return (
                          <NavLink
                            key={entityId}
                            className="inline-link"
                            to={`/entities/${entityId}?caseId=${encodeURIComponent(caseId)}`}
                          >
                            {entity ? entity.name : entityId}
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </AppLayout>
  );
}
