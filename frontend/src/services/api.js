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

export async function uploadCase({ title, priority = "Medium", status = "Active", files = [] }) {
  const formData = new FormData();
  formData.set("title", title);
  formData.set("priority", priority);
  formData.set("status", status);
  for (const file of files) {
    formData.append("files", file);
  }

  const response = await fetch(`${API_BASE_URL}/cases/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let detail = "Unable to create the case from the uploaded documents.";
    try {
      const payload = await response.json();
      detail = payload?.detail || detail;
    } catch {
      // response body wasn't JSON -- fall back to the generic message
    }
    throw new Error(detail);
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

// AI Investigation Assistant (Graph RAG): same response shape as
// searchSemantic() above, plus an `assistant` object ({ answer, sources,
// grounded, message, full_case_context, ... }) synthesized by a
// cloud-hosted LLM (see backend/app/graph_rag.py) from the retrieved graph
// context -- or, when the query doesn't resolve to one specific entity, a
// case-wide snapshot, so it can still attempt an answer to open-ended
// questions about the case as a whole. `assistant.answer` is null (not an
// error) when the LLM isn't reachable -- the rest of the response is still
// usable exactly like searchSemantic()'s.
export async function askAssistant(query, caseId) {
  return postJson("/search/assistant", { query, case_id: caseId });
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

// Report Generation: assembles a full investigation report (case summary,
// investigated entity, key connected entities, relationship paths, network
// summary, alerts, evidence, confirmed vs predicted relationships, timeline,
// AI executive summary, limitations, and metadata) from this case's existing
// graph/evidence/alert/timeline data -- see backend/app/reports.py. Uses its
// own error handling (like uploadCase above) so a failure surfaces the
// backend's actual `detail` message instead of a generic one.
export async function generateReport(caseId, entityId, generatedBy) {
  const response = await fetch(`${API_BASE_URL}/reports/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ case_id: caseId, entity_id: entityId || null, generated_by: generatedBy || null }),
  });

  if (!response.ok) {
    let detail = "Unable to generate the investigation report.";
    try {
      const payload = await response.json();
      detail = payload?.detail || detail;
    } catch {
      // response body wasn't JSON -- fall back to the generic message
    }
    throw new Error(detail);
  }

  return response.json();
}

export async function fetchActivitySessions() {
  const payload = await fetchJson("/activity/sessions");
  return Array.isArray(payload) ? payload : payload?.sessions || [];
}
