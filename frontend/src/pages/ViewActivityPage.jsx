import React from "react";
import { Navigate } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import useAuth from "../hooks/useAuth";
import { fetchActivitySessions } from "../services/api";

function formatDateTime(value, dateOnly = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", dateOnly
    ? { day: "2-digit", month: "short", year: "numeric" }
    : { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = Math.floor(total % 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s` : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

export default function ViewActivityPage() {
  const { user } = useAuth();
  const [sessions, setSessions] = React.useState([]);
  const [selectedSession, setSelectedSession] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("ALL");
  const [caseFilter, setCaseFilter] = React.useState("ALL");
  const [actionFilter, setActionFilter] = React.useState("ALL");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  const loadSessions = React.useCallback(() => {
    fetchActivitySessions()
      .then((payload) => {
        setSessions(Array.isArray(payload) ? payload : []);
        setError("");
      })
      .catch(() => setError("Unable to load investigator activity."))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    loadSessions();
    const refresh = window.setInterval(loadSessions, 5000);
    return () => {
      window.clearInterval(refresh);
    };
  }, [loadSessions]);

  if (user?.role !== "senior") return <Navigate to="/" replace />;

  const today = new Date().toISOString().slice(0, 10);
  const caseOptions = [...new Set(sessions.flatMap((session) => session.case_ids || []))].sort();
  const actionOptions = [...new Set(sessions.flatMap((session) => (session.activities || []).map((event) => event.action)))].sort();
  const visibleSessions = sessions.filter((session) => {
    const haystack = [session.officer_id, session.session_id, ...(session.case_ids || [])].join(" ").toLowerCase();
    const hasCase = caseFilter === "ALL" || (session.case_ids || []).includes(caseFilter);
    const hasAction = actionFilter === "ALL" || (session.activities || []).some((event) => event.action === actionFilter);
    return (status === "ALL" || session.status === status) && hasCase && hasAction && haystack.includes(query.trim().toLowerCase());
  });
  const activeCount = sessions.filter((session) => session.status === "ACTIVE").length;
  const sessionsToday = sessions.filter((session) => session.login_at?.startsWith(today)).length;
  const actionsToday = sessions.filter((session) => session.login_at?.startsWith(today)).reduce((sum, session) => sum + (Number(session.action_count) || 0), 0);

  return (
    <AppLayout title="View Activity" subtitle="Investigator activity monitoring">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>VIEW ACTIVITY</h2>
            <p className="panel-copy">Monitor synthetic investigator sessions and meaningful application activity.</p>
          </div>
        </div>
        <div className="activity-status-legend">
          <span><strong>ACTIVE</strong> recent heartbeat confirmed</span>
          <span><strong>COMPLETED</strong> explicit logout received</span>
          <span><strong>EXPIRED</strong> heartbeat timed out without logout</span>
        </div>
        <div className="stats-grid activity-stats">
          <div className="stat-card"><span className="muted-label">Total Investigators</span><strong className="metric-value">{new Set(sessions.map((item) => item.officer_id)).size}</strong></div>
          <div className="stat-card"><span className="muted-label">Currently Active</span><strong className="metric-value">{activeCount}</strong></div>
          <div className="stat-card"><span className="muted-label">Sessions Today</span><strong className="metric-value">{sessionsToday}</strong></div>
          <div className="stat-card"><span className="muted-label">Actions Today</span><strong className="metric-value">{actionsToday}</strong></div>
        </div>
        <div className="activity-filters">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Officer / Session / Case" aria-label="Search activity" />
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter session status">
            <option value="ALL">All Status</option><option value="ACTIVE">Active</option><option value="COMPLETED">Completed</option><option value="EXPIRED">Expired</option>
          </select>
          <select value={caseFilter} onChange={(event) => setCaseFilter(event.target.value)} aria-label="Filter activity case">
            <option value="ALL">All Cases</option>{caseOptions.map((caseId) => <option key={caseId} value={caseId}>{caseId}</option>)}
          </select>
          <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} aria-label="Filter activity action">
            <option value="ALL">All Actions</option>{actionOptions.map((action) => <option key={action} value={action}>{action}</option>)}
          </select>
        </div>
        {loading ? <div className="state-panel">Loading investigator activity...</div> : error ? <div className="state-panel error">{error}</div> : (
          <div className="activity-table-wrap">
            <table className="data-table activity-table">
              <thead><tr><th>Officer</th><th>Status</th><th>Login</th><th>Logout</th><th>Expired At</th><th>Duration</th><th>Last Activity</th><th>Actions</th><th>Case</th></tr></thead>
              <tbody>{visibleSessions.map((session) => {
                const duration = session.duration_seconds;
                return <tr key={session.session_id} onClick={() => setSelectedSession(session)} className="activity-row">
                  <td><strong>{session.officer_id}</strong><small>{session.session_id}</small></td>
                  <td><span className={`status-badge ${session.status === "ACTIVE" ? "low" : session.status === "COMPLETED" ? "medium" : "high"}`}>{session.status}</span></td>
                  <td>{formatDateTime(session.login_at)}</td><td>{session.status === "COMPLETED" ? formatDateTime(session.logout_at) : "-"}</td><td>{session.status === "EXPIRED" ? formatDateTime(session.expired_at) : "-"}</td><td>{formatDuration(duration)}</td><td>{formatDateTime(session.last_activity_at)}</td><td>{session.action_count || 0}</td><td>{session.case_ids?.join(", ") || "-"}</td>
                </tr>;
              })}</tbody>
            </table>
            {!visibleSessions.length && <div className="state-panel empty">No investigator sessions match the current filters.</div>}
          </div>
        )}
      </section>
      {selectedSession && <section className="panel activity-detail-panel">
        <div className="panel-header"><h2>{selectedSession.officer_id} SESSION DETAILS</h2><button type="button" className="inline-link" onClick={() => setSelectedSession(null)}>CLOSE</button></div>
        <div className="detail-grid compact"><div><span className="detail-label">Role</span><strong>{selectedSession.role}</strong></div><div><span className="detail-label">Session ID</span><strong>{selectedSession.session_id}</strong></div><div><span className="detail-label">Cases accessed</span><strong>{selectedSession.case_ids?.join(", ") || "-"}</strong></div><div><span className="detail-label">Pages / actions</span><strong>{selectedSession.pages?.join(", ") || "-"}</strong></div></div>
        <h3 className="activity-subheading">Recent Activity</h3>
        <div className="activity-event-list">{(selectedSession.activities || []).map((event) => <div key={`${event.timestamp}-${event.action}`} className="search-history-item"><strong>{formatDateTime(event.timestamp)}</strong><span>{event.action} · {event.case_id || "-"} {event.target_id ? `• ${event.target_id}` : ""}</span></div>)}</div>
      </section>}
    </AppLayout>
  );
}