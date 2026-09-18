export const API_BASE_URL = "/api";

async function fetchJson(path) {
  const response = await fetch(`${API_BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`Unable to load ${path.replace("/", "")} data from the API.`);
  }

  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Unable to analyze the investigation query.`);
  }

  return response.json();
}

export async function fetchDashboard(caseId) {
  return fetchJson(caseId ? `/dashboard?case_id=${encodeURIComponent(caseId)}` : "/dashboard");
}

export async function fetchCases() {
  const payload = await fetchJson("/cases");
  return Array.isArray(payload) ? payload : Array.isArray(payload?.cases) ? payload.cases : [];
}

export async function fetchCaseDetail(id) {
  return fetchJson(`/cases/${id}`);
}

export async function fetchNetwork(caseId) {
  return fetchJson(caseId ? `/network?case_id=${encodeURIComponent(caseId)}` : "/network");
}

export async function fetchEntities(caseId) {
  return fetchJson(caseId ? `/entities?case_id=${encodeURIComponent(caseId)}` : "/entities");
}

export async function fetchEntityDetail(id) {
  return fetchJson(`/entities/${id}`);
}

export async function fetchAlerts(caseId) {
  return fetchJson(caseId ? `/alerts?case_id=${encodeURIComponent(caseId)}` : "/alerts");
}

export async function fetchTimeline(caseId) {
  return fetchJson(caseId ? `/timeline?case_id=${encodeURIComponent(caseId)}` : "/timeline");
}

export async function searchSemantic(query, caseId) {
  return postJson("/search/semantic", { query, case_id: caseId });
}

export async function fetchEvidence(caseId, entityId, relationshipId) {
  const params = new URLSearchParams();
  if (caseId) params.set("case_id", caseId);
  if (entityId) params.set("entity_id", entityId);
  if (relationshipId) params.set("relationship_id", relationshipId);
  return fetchJson(`/evidence${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function fetchEvidenceById(evidenceId) {
  return fetchJson(`/evidence/${encodeURIComponent(evidenceId)}`);
}

export async function verifyEvidence(evidenceId, status) {
  return postJson(`/evidence/${encodeURIComponent(evidenceId)}/verify`, { status });
}

export async function fetchAuditLogs(caseId) {
  const params = caseId ? `?case_id=${encodeURIComponent(caseId)}` : "";
  return fetchJson(`/audit-logs${params}`);
}

export async function postAuditLog(entry) {
  let sessionId = null;
  try {
    sessionId = window.localStorage.getItem("nexus.demo.activity-session");
  } catch {
    sessionId = null;
  }
  return postJson("/audit-logs", { ...entry, session_id: entry.session_id || sessionId });
}

export async function startActivitySession(officerId, role) {
  return postJson("/activity/session/login", { officer_id: officerId, role });
}

export async function endActivitySession(officerId, sessionId) {
  return postJson("/activity/session/logout", { officer_id: officerId, role: "investigator", session_id: sessionId });
}

export async function sendActivityHeartbeat(officerId, sessionId) {
  return postJson("/activity/heartbeat", { officer_id: officerId, session_id: sessionId });
}

export async function fetchActivitySessions() {
  const payload = await fetchJson("/activity/sessions");
  return Array.isArray(payload) ? payload : payload?.sessions || [];
}
