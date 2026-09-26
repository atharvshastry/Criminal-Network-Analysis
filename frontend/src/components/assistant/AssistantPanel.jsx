import React from "react";
import { useNavigate } from "react-router-dom";
import useCase from "../../hooks/useCase";
import useAuth from "../../hooks/useAuth";
import { askAssistant, postAuditLog } from "../../services/api";

// Quick-start prompts shown until the investigator asks their first
// question -- clicking one fills (and submits) the input, so the assistant
// feels usable immediately instead of staring at an empty box.
const SUGGESTED_QUESTIONS = [
  "Summarize this case",
  "List all alerts",
  "Who are the key people in this network?",
  "Show AI-predicted connections",
];

// Fallback only for a response from before the backend started sending
// `source_links` (e.g. a cached/older result) -- guesses a route purely
// from the ID's string shape. This is unreliable on its own: evidence IDs
// are NOT uniformly formatted across cases (some are "E-CASE-...", others
// "EVID-CASE-..."), so it can't recognize every evidence citation, and it
// has no way to resolve a relationship ID (e.g. "R061") to anything at
// all. `assistant.source_links`, computed backend-side where the real
// record shapes are known, is what actually drives clickable sources below
// -- see graph_rag.py's _resolve_source_links().
function legacySourceRoute(sourceId) {
  if (!sourceId) return null;
  if (sourceId.startsWith("ent_") || sourceId.startsWith("ENT_")) {
    return `/entities/${encodeURIComponent(sourceId)}`;
  }
  if (sourceId.startsWith("EVID") || sourceId.startsWith("E-CASE") || sourceId.startsWith("E-case")) {
    return `/evidence?evidenceId=${encodeURIComponent(sourceId)}`;
  }
  return null;
}

// A source's tooltip/label depends on what kind of thing it points to -- a
// real document, an AI-inferred lead with no document, or (rare) a
// relationship the evidence store doesn't actually link to anything.
function sourceChipTitle(link) {
  if (!link) return undefined;
  if (link.kind === "entity") return "Open this entity's profile";
  if (link.kind === "predicted_relationship") {
    return link.note || "AI-predicted lead -- view the highlighted connection on the network graph";
  }
  if (link.kind === "evidence") {
    return link.via_relationship
      ? "Open the original document this relationship was drawn from"
      : "Open the original evidence document";
  }
  return link.note || undefined;
}

// The short "where this came from" text shown beside each source's ID --
// the document's own title for an evidence citation (falling back to its
// record type if it has no title), the entity's name, or a plain
// AI-predicted/no-evidence label for the two cases with no document at all.
// `document_source` (police station, "Uploaded document", ...) is appended
// when present for a bit more context without cluttering the main label.
function sourceOriginLabel(link) {
  if (!link) return null;
  const label = link.label || null;
  if (!label) return null;
  return link.document_source ? `${label} · ${link.document_source}` : label;
}

// The assistant is prompted (see backend/app/graph_rag.py SYSTEM_INSTRUCTIONS)
// to always answer in a fixed "Answer: / Connection Path: / Evidence: /
// Confidence/Status:" plain-text structure. This parses that back out so it
// can be rendered as distinct, investigator-scannable sections instead of
// one run-on paragraph. Deliberately lenient (case-insensitive, tolerates
// wrapped lines) since a small/free-tier LLM won't always match the format
// byte-for-byte -- and if it doesn't look structured at all (no "Answer:"
// line found), this returns null so the caller falls back to plain text
// rather than rendering a broken, half-parsed layout.
const STRUCTURED_SECTION_RE = /^(answer|connection path|evidence|confidence\s*\/\s*status)\s*:\s*(.*)$/i;

function parseStructuredAnswer(text) {
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const sections = { answer: "", path: "", evidence: [], status: "" };
  let current = null;
  let sawAnswer = false;

  for (const line of lines) {
    const match = line.match(STRUCTURED_SECTION_RE);
    if (match) {
      const key = match[1].toLowerCase().replace(/\s+/g, " ");
      const rest = match[2].trim();
      if (key === "answer") {
        current = "answer";
        sections.answer = rest;
        sawAnswer = true;
      } else if (key === "connection path") {
        current = "path";
        sections.path = rest;
      } else if (key === "evidence") {
        current = "evidence";
        if (rest) sections.evidence.push(rest.replace(/^-+\s*/, ""));
      } else if (key.startsWith("confidence")) {
        current = "status";
        sections.status = rest;
      }
      continue;
    }
    // A continuation of whichever section came before it -- either a
    // wrapped line, or an evidence bullet ("- ...") that follows its own
    // "Evidence:" header on the next line rather than the same one.
    if (current === "evidence") {
      sections.evidence.push(line.replace(/^-+\s*/, ""));
    } else if (current === "answer") {
      sections.answer = sections.answer ? `${sections.answer} ${line}` : line;
    } else if (current === "path") {
      sections.path = sections.path ? `${sections.path} ${line}` : line;
    } else if (current === "status") {
      sections.status = sections.status ? `${sections.status} ${line}` : line;
    }
  }

  if (!sawAnswer) return null;
  return sections;
}

function statusBadgeVariant(status) {
  const normalized = (status || "").trim().toLowerCase();
  if (normalized.startsWith("confirmed")) return "confirmed";
  if (normalized.startsWith("predicted")) return "predicted";
  if (normalized.startsWith("insufficient")) return "insufficient";
  return "neutral";
}

function AssistantAnswer({ result, onNavigateSource }) {
  const assistant = result?.assistant;

  if (!assistant) {
    return (
      <div className="assistant-answer-block">
        <p className="search-message">No response from the assistant.</p>
      </div>
    );
  }

  if (assistant.grounded && assistant.answer) {
    const structured = parseStructuredAnswer(assistant.answer);
    return (
      <div className="assistant-answer-block">
        {structured ? (
          <div className="assistant-structured-answer">
            <p className="assistant-answer-text">{structured.answer}</p>
            {structured.path && (
              <div className="assistant-path-row">
                <span className="muted-label">CONNECTION PATH</span>
                <p className="assistant-path-chain">{structured.path}</p>
              </div>
            )}
            {structured.evidence.length > 0 && (
              <div className="assistant-evidence-row">
                <span className="muted-label">EVIDENCE</span>
                <ul className="assistant-evidence-list">
                  {structured.evidence.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {structured.status && (
              <span
                className={`status-badge assistant-status-badge ${statusBadgeVariant(structured.status)}`}
              >
                {structured.status}
              </span>
            )}
          </div>
        ) : (
          <p className="subsection-copy assistant-answer-plain">{assistant.answer}</p>
        )}
        {assistant.sources?.length > 0 && (
          <div className="assistant-source-row">
            <span className="muted-label">SOURCES — WHERE THIS CAME FROM</span>
            <ul className="assistant-source-list">
              {assistant.sources.map((sourceId) => {
                const link = assistant.source_links?.[sourceId] || null;
                // A predicted/AI-inferred relationship has no source
                // document -- by design, not a bug -- so it's routed to the
                // Network Explorer (the graph is its "source") instead of a
                // document link. Everything else that has a route goes to
                // the Evidence page or the entity's profile.
                const clickable = link
                  ? link.route != null
                  : Boolean(legacySourceRoute(sourceId));
                const isPredicted = link?.kind === "predicted_relationship";
                const title = link ? sourceChipTitle(link) : undefined;
                const originLabel = sourceOriginLabel(link);

                const badge = (
                  <span className={`assistant-source-badge${isPredicted ? " assistant-source-badge-predicted" : ""}`}>
                    {sourceId}
                  </span>
                );

                if (!clickable) {
                  return (
                    <li key={sourceId} className="assistant-source-item assistant-source-item-static" title={title}>
                      {badge}
                      <span className="assistant-source-label muted-note">
                        {originLabel || link?.note || "Not linked to a specific document"}
                      </span>
                    </li>
                  );
                }

                return (
                  <li key={sourceId} className="assistant-source-item">
                    <button
                      type="button"
                      className="assistant-source-link-button"
                      title={title}
                      onClick={() => onNavigateSource(link || { route: legacySourceRoute(sourceId) })}
                    >
                      {badge}
                      <span className="assistant-source-label">{originLabel || sourceId}</span>
                      <span className="assistant-source-action">
                        {isPredicted ? "View on graph →" : "View evidence →"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {assistant.unverified_mentions?.length > 0 && (
          <p className="search-message">
            Note: the assistant referenced {assistant.unverified_mentions.join(", ")}, which could not be
            verified against the retrieved case graph/evidence.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="assistant-answer-block">
      <p className="search-message">
        {assistant.message || result.message || "No answer is available for this question."}
      </p>
    </div>
  );
}

// The reusable core of the AI Investigation Assistant (Graph RAG): a case
// picker, a running conversation, quick-start suggestions, and clickable
// source citations that jump straight to the cited entity/evidence record.
// Used both inline on a dedicated page (AIAssistantPage) and inside the
// Dashboard's quick-access modal (AIInvestigationAssistant) -- each mounts
// its own instance with independent conversation state.
export default function AssistantPanel({ autoScroll = true }) {
  const { caseId, cases, setCaseId } = useCase();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [selectedCaseId, setSelectedCaseId] = React.useState(caseId || "");
  const [question, setQuestion] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [conversation, setConversation] = React.useState([]);
  const conversationEndRef = React.useRef(null);

  React.useEffect(() => {
    if (!selectedCaseId && caseId) {
      setSelectedCaseId(caseId);
    }
  }, [caseId, selectedCaseId]);

  React.useEffect(() => {
    if (autoScroll) {
      conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [conversation, loading, autoScroll]);

  const runQuery = (rawQuery) => {
    const trimmed = rawQuery.trim();
    if (!trimmed || loading) {
      return;
    }
    if (!selectedCaseId) {
      setError("Select a case before asking the assistant.");
      return;
    }

    setLoading(true);
    setError("");

    askAssistant(trimmed, selectedCaseId)
      .then((result) => {
        setConversation((current) => [
          ...current,
          { id: `${Date.now()}-${current.length}`, question: trimmed, result },
        ]);
        setQuestion("");
        if (user) {
          postAuditLog({
            officer_id: user.id,
            role: user.role,
            action: "AI_ASSISTANT_QUERY",
            case_id: selectedCaseId,
            metadata: { query: trimmed },
          }).catch(() => undefined);
        }
      })
      .catch(() => {
        setError("Unable to reach the investigation assistant. Please try again.");
      })
      .finally(() => setLoading(false));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    runQuery(question);
  };

  // The assistant has its own case picker, independent of the app-wide
  // active case (useCase()) that Evidence/Network Explorer/etc. read from --
  // an investigator can ask about a different case here than whatever is
  // selected elsewhere. So before jumping to a source, sync the app-wide
  // case to whichever case this answer actually came from, otherwise the
  // destination page would load the WRONG case's evidence/network.
  const handleNavigateSource = (link) => {
    if (!link?.route) return;
    if (selectedCaseId && selectedCaseId !== caseId) {
      setCaseId(selectedCaseId);
    }
    if (link.trace) {
      try {
        window.sessionStorage.setItem("trace-evidence-context", JSON.stringify(link.trace));
      } catch {
        // sessionStorage can be unavailable (private browsing, etc.) -- the
        // Network Explorer just won't have anything to highlight then.
      }
    }
    navigate(link.route);
  };

  return (
    <div className="assistant-panel">
      <div className="assistant-case-picker">
        <label htmlFor="assistant-case-select">Case</label>
        <select
          id="assistant-case-select"
          value={selectedCaseId}
          onChange={(event) => setSelectedCaseId(event.target.value)}
        >
          <option value="">Select a case…</option>
          {cases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} — {item.title}
            </option>
          ))}
        </select>
      </div>

      {conversation.length === 0 && !loading && (
        <div className="assistant-suggestions">
          <span className="muted-label">TRY ASKING</span>
          <div className="assistant-chip-row">
            {SUGGESTED_QUESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="assistant-chip assistant-chip-suggestion"
                onClick={() => runQuery(suggestion)}
                disabled={!selectedCaseId || loading}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="assistant-conversation">
        {conversation.map((turn) => (
          <div key={turn.id} className="assistant-turn">
            <div className="assistant-question">{turn.question}</div>
            <AssistantAnswer result={turn.result} onNavigateSource={handleNavigateSource} />
          </div>
        ))}
        {loading && <div className="state-panel">Analyzing the case graph…</div>}
        {error && <div className="state-panel error">{error}</div>}
        <div ref={conversationEndRef} />
      </div>

      <form className="assistant-input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about an entity, relationship, or the case as a whole…"
          disabled={loading}
        />
        <button type="submit" className="primary-button" disabled={loading || !question.trim()}>
          {loading ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
