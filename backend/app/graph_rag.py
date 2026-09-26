"""
Graph RAG synthesis layer.

This module does NOT re-implement retrieval. It takes exactly what
search_network() in main.py already retrieves -- resolved entities, graph
path/neighborhood relationships, and evidence records pulled via
evidence_for_selection() -- and adds one new step on top: asking an LLM to
write a short, evidence-cited natural-language answer grounded strictly in
that retrieved context.

Design constraints (see ARCHITECTURE.md, README.md, and the task brief this
was built against):
  - No vector database, no LangChain/LlamaIndex. The existing JSON-graph
    traversal + evidence lookup in main.py is the retrieval layer; this
    module is only the "write the answer" step.
  - The LLM only ever sees what was actually retrieved. If search_network()
    found no entity/path/evidence/notes, this module doesn't call the LLM
    at all.
  - If the LLM isn't reachable or errors out, the rest of the app keeps
    working exactly as it did before this feature existed -- callers get
    `assistant.answer = None` with a plain-language reason, never a 500.

LLM backend: this build calls Google's Gemini API via its OpenAI-compatible
chat-completions endpoint (https://ai.google.dev/gemini-api/docs/openai),
configured entirely through backend/.env (GRAPH_RAG_LLM_URL/MODEL/API_KEY --
see backend/.env.example). Only the Python standard library (urllib) is
used for the HTTP call, so this file adds zero new entries to
requirements.txt. Point GRAPH_RAG_LLM_URL/MODEL at any other
OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter, a self-hosted
llama.cpp/vLLM server, ...) to switch providers without touching this file.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Configuration -- all overridable via environment variables (see
# backend/.env.example). Defaults point at Gemini; set GRAPH_RAG_LLM_API_KEY
# in backend/.env to enable it.
# ---------------------------------------------------------------------------

def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


GRAPH_RAG_ENABLED = _env_bool("GRAPH_RAG_ENABLED", True)
GRAPH_RAG_LLM_URL = os.environ.get(
    "GRAPH_RAG_LLM_URL", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
)
GRAPH_RAG_LLM_MODEL = os.environ.get("GRAPH_RAG_LLM_MODEL", "gemini-3.6-flash")
# Get a key at https://aistudio.google.com/apikey (or your chosen provider's
# console if you repointed GRAPH_RAG_LLM_URL). Required -- generate_answer()
# fails fast with a clear message if this is blank, rather than making a
# request that's guaranteed to be rejected.
GRAPH_RAG_LLM_API_KEY = os.environ.get("GRAPH_RAG_LLM_API_KEY", "")

# If the primary provider above is unreachable, overloaded (429/503), or
# times out -- even after the retries below -- fall back to this second,
# INDEPENDENT provider once before giving up. Deliberately a fully separate
# URL/model/key (not just a different model on the same provider): an
# outage on the primary provider's infrastructure would take out same-
# provider fallbacks too, so this is meant to point at a different vendor
# (e.g. Groq, https://console.groq.com/keys -- free, and fast enough that
# it barely adds latency even when it's not needed). Leave
# GRAPH_RAG_LLM_FALLBACK_URL blank to disable fallback entirely.
GRAPH_RAG_LLM_FALLBACK_URL = os.environ.get("GRAPH_RAG_LLM_FALLBACK_URL", "")
GRAPH_RAG_LLM_FALLBACK_MODEL = os.environ.get("GRAPH_RAG_LLM_FALLBACK_MODEL", "")
GRAPH_RAG_LLM_FALLBACK_API_KEY = os.environ.get("GRAPH_RAG_LLM_FALLBACK_API_KEY", "")
GRAPH_RAG_TIMEOUT_SECONDS = _env_int("GRAPH_RAG_TIMEOUT_SECONDS", 30)
# Bumped from 1500 -> 3500: this used to bound `summary` (already only a
# ~400-char preview -- see _evidence_narrative below), so it was never the
# real limiting factor. Now that the fuller narrative is assembled first,
# this is what actually caps how much of one evidence record's content
# reaches the LLM, so it needs real headroom for a multi-paragraph FIR/CDR
# excerpt rather than a size tuned for a one-line summary.
GRAPH_RAG_MAX_EVIDENCE_CHARS = _env_int("GRAPH_RAG_MAX_EVIDENCE_CHARS", 3500)
GRAPH_RAG_MAX_EVIDENCE_RECORDS = _env_int("GRAPH_RAG_MAX_EVIDENCE_RECORDS", 8)
GRAPH_RAG_MAX_NOTES = _env_int("GRAPH_RAG_MAX_NOTES", 10)
# Gemini's free tier occasionally returns 503 ("model overloaded") or 429
# (rate limited) for a moment under load -- both are usually gone within a
# couple of seconds, so a couple of short retries meaningfully improves
# demo reliability instead of surfacing a transient blip as a hard failure.
GRAPH_RAG_LLM_MAX_RETRIES = _env_int("GRAPH_RAG_LLM_MAX_RETRIES", 2)
GRAPH_RAG_LLM_RETRY_DELAY_SECONDS = _env_int("GRAPH_RAG_LLM_RETRY_DELAY_SECONDS", 2)
_RETRYABLE_HTTP_STATUSES = {429, 503}

# Case-wide fallback (see build_full_case_pack below): how much of the case
# graph/evidence/timeline/alerts to hand the LLM when search_network()'s
# rule-based intent classifier didn't resolve a specific entity/intent for
# this question. Kept independent from the targeted-retrieval caps above so
# tuning one doesn't silently change the other.
GRAPH_RAG_MAX_FULL_ENTITIES = _env_int("GRAPH_RAG_MAX_FULL_ENTITIES", 60)
GRAPH_RAG_MAX_FULL_RELATIONSHIPS = _env_int("GRAPH_RAG_MAX_FULL_RELATIONSHIPS", 100)
GRAPH_RAG_MAX_FULL_EVIDENCE = _env_int("GRAPH_RAG_MAX_FULL_EVIDENCE", 15)
GRAPH_RAG_MAX_FULL_TIMELINE = _env_int("GRAPH_RAG_MAX_FULL_TIMELINE", 15)
GRAPH_RAG_MAX_FULL_ALERTS = _env_int("GRAPH_RAG_MAX_FULL_ALERTS", 15)
GRAPH_RAG_MAX_FULL_NOTES = _env_int("GRAPH_RAG_MAX_FULL_NOTES", 20)


class LLMUnavailableError(Exception):
    """Raised when the LLM can't be reached or returns something unusable.
    Always caught by generate_answer() -- never bubbles up to the API layer."""


# ---------------------------------------------------------------------------
# Context pack: the *only* material the LLM is allowed to see, bounded to
# exactly what search_network() already resolved for this query.
# ---------------------------------------------------------------------------

@dataclass
class ContextPack:
    query: str
    case_id: str
    intent: str
    entities: list = field(default_factory=list)        # [{id, name, type}]
    relationships: list = field(default_factory=list)    # [{id, source, target, type, confidence, status}]
    evidence: list = field(default_factory=list)         # [{id, title, source, summary}]
    notes: list = field(default_factory=list)             # [str] -- case-level facts with no single entity/evidence ID
    entity_ids: set = field(default_factory=set)
    evidence_ids: set = field(default_factory=set)
    relationship_ids: set = field(default_factory=set)
    # True when this pack came from build_full_case_pack() (case-wide
    # snapshot) rather than build_context_pack() (search_network()'s
    # targeted retrieval for one entity/intent) -- changes the prompt's
    # framing and length allowance in build_prompt().
    full_case: bool = False

    def is_empty(self) -> bool:
        return not self.entities and not self.relationships and not self.evidence and not self.notes


def _add_note(pack: ContextPack, text: str, max_notes: int = GRAPH_RAG_MAX_NOTES) -> None:
    text = (text or "").strip()
    if not text or text in pack.notes or len(pack.notes) >= max_notes:
        return
    pack.notes.append(text)


# A generic one-line placeholder extraction.py writes into `evidence_note`
# for every uploaded document ("Processed from the case's original FIR
# document by the extraction pipeline.") -- worth nothing on its own, so it
# shouldn't count as "real" narrative content when deciding whether
# evidence_note has anything to add beyond `summary`.
_EVIDENCE_NOTE_PLACEHOLDER_RE = re.compile(r"^processed from the case'?s .*\bextraction pipeline\.?$", re.IGNORECASE)


def _evidence_narrative(record: dict) -> str:
    """The fullest available narrative for one evidence record -- not just
    its short `summary`. This was the actual bottleneck behind incomplete
    Investigation Assistant answers: `summary` is only a ~1-3 sentence / up
    to ~400-character preview (see extraction.py's
    `excerpt[:400] + "..."` and build_dataset.py's synthetic summaries), and
    the previous context-building code (`record.get("summary") or
    record.get("evidence_note") or ""`) never actually fell through to
    anything richer, because `summary` is always non-empty once a document
    has been processed. Two much richer sources were sitting unused as a
    result:

    - `document`: the structured FIR/report fields the seed case data (and
      some evidence types) carry -- full incident description, date/time/
      place of occurrence, offence sections, every entity explicitly named
      in the document, and the investigating officer's own follow-up notes.
      None of this reached the LLM before.
    - `evidence_note`: for a genuinely user-uploaded document (see
      extraction.py), this holds the FULL raw extracted text (up to ~20k
      characters) -- often several thousand characters longer than
      `summary`'s ~400-character preview of the same text. A real uploaded
      case in this project's own data has a 4,078-character `evidence_note`
      whose content (suspect names, phone numbers, a bank account, witness
      statements) starts right after the point where `summary` used to be
      cut off -- i.e. it was entirely invisible to the assistant before.

    Both are layered on top of (not instead of) `summary`, so nothing that
    worked before is lost -- this only adds context that used to be
    silently discarded.
    """
    summary = (record.get("summary") or "").strip()
    document = record.get("document")

    if isinstance(document, dict):
        parts = [summary] if summary else []
        detail_lines = []
        occurrence_bits = [
            document.get("date_of_occurrence"), document.get("time_of_occurrence"), document.get("place_of_occurrence"),
        ]
        if any(occurrence_bits):
            detail_lines.append("Occurred: " + ", ".join(bit for bit in occurrence_bits if bit))
        if document.get("description"):
            detail_lines.append(f"Full account: {document['description']}")
        if document.get("offence_sections"):
            detail_lines.append("Offence sections: " + "; ".join(document["offence_sections"]))
        if document.get("persons_referenced"):
            detail_lines.append("Entities referenced in this document: " + "; ".join(document["persons_referenced"]))
        if document.get("initial_investigation_notes"):
            detail_lines.append("Investigation notes: " + " ".join(document["initial_investigation_notes"]))
        if detail_lines:
            parts.append("\n".join(detail_lines))
        return "\n".join(parts) if parts else "No narrative available for this evidence record."

    note = (record.get("evidence_note") or "").strip()
    if note and not _EVIDENCE_NOTE_PLACEHOLDER_RE.match(note):
        # For a genuinely uploaded document, `summary` is typically just a
        # truncated prefix of this same text (extraction.py builds it as
        # `excerpt[:400] + "..."` from the very same excerpt). When
        # `evidence_note` already starts with that prefix, use it alone
        # instead of repeating the same opening paragraph twice in the
        # prompt; otherwise (a genuinely different/abstractive summary)
        # keep both so nothing is lost.
        if summary and note.startswith(summary[:200].rstrip(". …")):
            return note
        return f"{summary}\n{note}" if summary else note

    return summary or "No narrative available for this evidence record."


def build_context_pack(query: str, case_id: str, search_result: dict, node_index: dict) -> ContextPack:
    """`search_result` is exactly what main.search_network() returns.
    `node_index` is {node_id: node} for this case's network (main.py already
    builds this once per request for search_network itself)."""
    pack = ContextPack(
        query=query,
        case_id=case_id,
        intent=(search_result.get("intent") or {}).get("type", "GENERAL_SEARCH"),
    )

    def add_entity(entity_id, name, entity_type):
        if not entity_id or entity_id in pack.entity_ids:
            return
        pack.entity_ids.add(entity_id)
        pack.entities.append({"id": entity_id, "name": name or entity_id, "type": entity_type or "UNKNOWN"})

    resolved = search_result.get("resolved_entity")
    if resolved:
        add_entity(resolved.get("id"), resolved.get("name"), resolved.get("type"))
    for entity in search_result.get("entities", []) or []:
        add_entity(entity.get("id"), entity.get("name"), entity.get("type"))
    for entity in search_result.get("connected_entities", []) or []:
        add_entity(entity.get("id"), entity.get("name"), entity.get("type"))

    for relationship in search_result.get("relationships", []) or []:
        source_id = relationship.get("source")
        target_id = relationship.get("target")
        source_node = node_index.get(source_id, {})
        target_node = node_index.get(target_id, {})
        add_entity(source_id, source_node.get("label", source_id), source_node.get("type"))
        add_entity(target_id, target_node.get("label", target_id), target_node.get("type"))
        relationship_id = relationship.get("id")
        pack.relationships.append({
            "id": relationship_id,
            "source": source_node.get("label", source_id),
            "target": target_node.get("label", target_id),
            # Raw entity IDs alongside the display labels above -- kept so a
            # citation of this relationship can be routed to a concrete place
            # in the app (e.g. highlighting these two nodes on the Network
            # Explorer for a predicted/unconfirmed link) without having to
            # reverse a label back into an ID. See _resolve_source_links().
            "source_id": source_id,
            "target_id": target_id,
            "type": relationship.get("type"),
            "confidence": relationship.get("confidence"),
            "status": "predicted" if relationship.get("type") == "PREDICTED" else "confirmed",
        })
        if relationship_id:
            pack.relationship_ids.add(relationship_id)

    # Evidence records (with the literal source excerpt) are what
    # evidence_for_selection() already attached to the search_network()
    # response -- reuse them as-is rather than re-deriving anything. The
    # narrative itself now comes from _evidence_narrative() rather than the
    # short `summary` field alone -- see that function's docstring for why.
    for record in (search_result.get("evidence") or [])[:GRAPH_RAG_MAX_EVIDENCE_RECORDS]:
        record_id = record.get("id")
        narrative = _evidence_narrative(record)
        pack.evidence.append({
            "id": record_id,
            "title": record.get("title") or record_id or "Evidence record",
            "source": record.get("source", "unknown"),
            "summary": narrative[:GRAPH_RAG_MAX_EVIDENCE_CHARS],
        })
        if record_id:
            pack.evidence_ids.add(record_id)

    # Several intents (case summary, "list all alerts", timeline, predicted
    # links, ...) are answered by search_network() via handle_generic_intent()
    # without ever populating entities/relationships/evidence -- the answer
    # instead lives in `results[].reason` (a ready-made summary sentence),
    # `alerts`, or `timeline`. Without this, e.g. "summarize this case" or
    # "list all alerts" would look empty to the LLM even though
    # search_network() actually found something. These go in as unattributed
    # case-level notes (no entity/evidence ID to cite), not as citable
    # sources.
    for item in search_result.get("results", []) or []:
        _add_note(pack, item.get("reason"))

    for alert in (search_result.get("alerts", []) or [])[:GRAPH_RAG_MAX_NOTES]:
        reasons = alert.get("reasons") or []
        _add_note(pack, f"Alert ({alert.get('severity', 'INFO')}): {alert.get('title', alert.get('id'))}" + (f" — {reasons[0]}" if reasons else ""))

    for event in (search_result.get("timeline", []) or [])[:GRAPH_RAG_MAX_NOTES]:
        timestamp = event.get("timestamp", "")
        _add_note(pack, f"{timestamp}: {event.get('title', '')} — {event.get('description', '')}".strip(": —"))

    return pack


# ---------------------------------------------------------------------------
# Case-wide fallback pack: used when search_network()'s rule-based intent
# classifier didn't resolve anything for this question (NO_MATCH/NO_PATH, an
# AMBIGUOUS match, or any other status that leaves build_context_pack()
# empty). Rather than the assistant flatly refusing, this hands the LLM a
# bounded snapshot of the *entire* case -- most-central entities, their
# relationships, evidence, alerts and timeline -- so genuinely open-ended,
# comparative, or classifier-unrecognized questions ("who talks to the most
# people here", "does anything about this case look odd", "what would you
# check next") can still get a grounded attempt instead of a dead end.
# ---------------------------------------------------------------------------

def build_full_case_pack(
    query: str,
    case_id: str,
    network: dict,
    evidence_records: list,
    timeline_records: list,
    alerts_records: list,
) -> ContextPack:
    pack = ContextPack(query=query, case_id=case_id, intent="FULL_CASE_CONTEXT", full_case=True)

    nodes = network.get("nodes", []) or []
    edges = network.get("edges", []) or []
    node_index = {node.get("id"): node for node in nodes}

    def add_entity(entity_id, name, entity_type):
        if not entity_id or entity_id in pack.entity_ids:
            return
        pack.entity_ids.add(entity_id)
        pack.entities.append({"id": entity_id, "name": name or entity_id, "type": entity_type or "UNKNOWN"})

    # Most-central entities first (pagerank/centrality/degree -- whichever
    # the pipeline populated), so a hard entity cap keeps the entities most
    # likely to matter rather than an arbitrary slice of the node list.
    ranked_nodes = sorted(
        nodes,
        key=lambda n: (n.get("centrality") or n.get("pagerank") or n.get("degree") or 0),
        reverse=True,
    )
    for node in ranked_nodes[:GRAPH_RAG_MAX_FULL_ENTITIES]:
        add_entity(node.get("id"), node.get("label", node.get("id")), node.get("type"))

    # Confirmed relationships before predicted/unconfirmed ones, then by
    # confidence, so the cap favors established facts over AI-suggested
    # leads when a large case has to be trimmed to fit the prompt.
    ranked_edges = sorted(
        edges,
        key=lambda e: (e.get("status") != "predicted", e.get("confidence") or 0),
        reverse=True,
    )
    for edge in ranked_edges[:GRAPH_RAG_MAX_FULL_RELATIONSHIPS]:
        source_id = edge.get("source")
        target_id = edge.get("target")
        source_node = node_index.get(source_id, {})
        target_node = node_index.get(target_id, {})
        add_entity(source_id, source_node.get("label", source_id), source_node.get("type"))
        add_entity(target_id, target_node.get("label", target_id), target_node.get("type"))
        edge_id = edge.get("id")
        is_predicted = edge.get("status") == "predicted" or edge.get("type") == "PREDICTED"
        pack.relationships.append({
            "id": edge_id,
            "source": source_node.get("label", source_id),
            "target": target_node.get("label", target_id),
            "source_id": source_id,
            "target_id": target_id,
            "type": edge.get("type"),
            "confidence": edge.get("confidence"),
            "status": "predicted" if is_predicted else "confirmed",
        })
        if edge_id:
            pack.relationship_ids.add(edge_id)

    for record in (evidence_records or [])[:GRAPH_RAG_MAX_FULL_EVIDENCE]:
        record_id = record.get("id")
        narrative = _evidence_narrative(record)
        pack.evidence.append({
            "id": record_id,
            "title": record.get("title") or record_id or "Evidence record",
            "source": record.get("source", "unknown"),
            "summary": narrative[:GRAPH_RAG_MAX_EVIDENCE_CHARS],
        })
        if record_id:
            pack.evidence_ids.add(record_id)

    for alert in (alerts_records or [])[:GRAPH_RAG_MAX_FULL_ALERTS]:
        reasons = alert.get("reasons") or []
        _add_note(
            pack,
            f"Alert ({alert.get('severity', 'INFO')}): {alert.get('title', alert.get('id'))}" + (f" — {reasons[0]}" if reasons else ""),
            max_notes=GRAPH_RAG_MAX_FULL_NOTES,
        )

    for event in (timeline_records or [])[:GRAPH_RAG_MAX_FULL_TIMELINE]:
        timestamp = event.get("timestamp", "")
        _add_note(
            pack,
            f"{timestamp}: {event.get('title', '')} — {event.get('description', '')}".strip(": —"),
            max_notes=GRAPH_RAG_MAX_FULL_NOTES,
        )

    return pack


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

SYSTEM_INSTRUCTIONS = (
    "You are an investigative assistant inside a police case-analysis tool, speaking "
    "directly to a trained investigator. Follow these rules exactly:\n"
    "1. Be precise, factual, and concise -- no filler, no hedging beyond what the "
    "evidence actually supports.\n"
    "2. Use ONLY the entities, relationships, evidence excerpts, and case notes listed "
    "below. Never invent people, relationships, events, transactions, or evidence, and "
    "never use outside/general world knowledge to fill in anything this context doesn't "
    "state.\n"
    "3. Clearly distinguish CONFIRMED relationships from PREDICTED/AI-inferred ones -- "
    "the context below tags each relationship '(PREDICTED / unconfirmed)' where that "
    "applies. Do not treat a predicted/similarity-based link, or any probability, as an "
    "established fact.\n"
    "4. Never state or imply that a named person is guilty of a crime -- describe "
    "connections and evidence neutrally, as investigative leads for a human "
    "investigator to corroborate.\n"
    "5. When you reference a specific entity, relationship, or evidence item, cite its "
    "exact ID in square brackets exactly as given below, e.g. [ent_00007] or "
    "[EVID-CASE-2026-00478-001]. Case notes have no ID -- summarize them in prose "
    "without inventing a bracketed citation for them. Put nothing else in square "
    "brackets.\n"
    "6. If the available context is insufficient to answer, the Answer line must say "
    "exactly: \"Insufficient evidence found in the available case data.\" If the "
    "question asks about a connection between entities and none exists in the context, "
    "the Answer line must say exactly: \"No connection was found in the available "
    "data.\"\n"
    "7. If the question asks \"why\" something is connected, explain it using the "
    "retrieved evidence. If it asks \"who\", list the relevant entities and their "
    "relationship types. If it asks for evidence, name the source document/type and "
    "quote or closely paraphrase the supporting evidence text. When several pieces of "
    "evidence exist, combine them into one clear investigation summary rather than "
    "listing them disconnectedly.\n\n"
    "Respond in EXACTLY this structure, as plain text with no markdown headers or "
    "bullet symbols other than shown:\n"
    "Answer: <direct answer to the question, in prose>\n"
    "Connection Path: <Entity --RELATIONSHIP--> Entity --RELATIONSHIP--> Entity, citing "
    "each entity/relationship ID per rule 5; include this line only if the question "
    "involves a relationship or path between two or more entities, otherwise omit the "
    "line entirely>\n"
    "Evidence:\n"
    "- <source document/type> -- <supporting evidence text, citing its ID per rule 5> "
    "(one bullet per evidence item actually used; if none apply, write exactly one "
    "bullet: \"- No supporting evidence record available.\")\n"
    "Confidence/Status: <exactly one word/phrase: Confirmed, Predicted, or Insufficient "
    "evidence -- plain text, do NOT wrap it in square brackets>"
)

# Appended to SYSTEM_INSTRUCTIONS depending on whether the context is
# targeted (one resolved entity/intent) or a case-wide fallback snapshot
# (see build_full_case_pack) -- the latter gets more room to cover more
# ground and an explicit nudge not to refuse just because the snapshot is a
# trimmed subset, while still keeping the same required structure.
TARGETED_LENGTH_NOTE = " Keep the Answer line to 1-3 sentences and list at most 5 evidence bullets."
FULL_CASE_NOTE = (
    " The question below wasn't anchored to one specific entity or a "
    "recognized question type by the case-search step, so instead you've "
    "been given a case-wide snapshot: this case's most central entities, "
    "their relationships, evidence, alerts, and timeline notes, bounded to "
    "fit this prompt -- not necessarily every entity in the case. Use it to "
    "answer as fully and specifically as you can within the structure above. "
    "If it genuinely isn't enough, use the exact insufficient-evidence "
    "wording from rule 6 rather than guessing. Keep the Answer line to 2-4 "
    "sentences and list at most 8 evidence bullets."
)


def _format_context(pack: ContextPack) -> str:
    lines = []
    if pack.entities:
        lines.append("ENTITIES:")
        for entity in pack.entities:
            lines.append(f"- [{entity['id']}] {entity['name']} ({entity['type']})")
    if pack.relationships:
        lines.append("\nRELATIONSHIPS:")
        for relationship in pack.relationships:
            tag = " (PREDICTED / unconfirmed)" if relationship["status"] == "predicted" else ""
            confidence = relationship.get("confidence")
            confidence_text = f", confidence {confidence}" if confidence is not None else ""
            rel_id = f" [{relationship['id']}]" if relationship.get("id") else ""
            lines.append(
                f"- {relationship['source']} --{relationship['type']}--> {relationship['target']}"
                f"{tag}{confidence_text}{rel_id}"
            )
    if pack.evidence:
        lines.append("\nSUPPORTING EVIDENCE:")
        for record in pack.evidence:
            lines.append(f"- [{record['id']}] {record['title']} (source: {record['source']}): {record['summary']}")
    if pack.notes:
        lines.append("\nCASE NOTES (no single entity/evidence ID -- do not cite these in brackets):")
        for note in pack.notes:
            lines.append(f"- {note}")
    return "\n".join(lines)


def build_prompt(pack: ContextPack) -> str:
    instructions = SYSTEM_INSTRUCTIONS + (FULL_CASE_NOTE if pack.full_case else TARGETED_LENGTH_NOTE)
    return (
        f"{instructions}\n\n"
        f"INVESTIGATOR'S QUESTION:\n{pack.query}\n\n"
        f"CONTEXT (retrieved from the case graph and evidence store):\n{_format_context(pack)}\n\n"
        f"ANSWER:"
    )


# ---------------------------------------------------------------------------
# LLM call -- stdlib urllib only, so this adds no new dependency. Talks to
# any OpenAI-compatible chat-completions endpoint; defaults to Gemini's.
# ---------------------------------------------------------------------------

def _call_chat_completions(prompt: str, url: str, model: str, api_key: str) -> str:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Some providers (Groq's API sits behind Cloudflare) block requests
        # whose User-Agent is a dead giveaway of an unattended script --
        # urllib's default ("Python-urllib/3.x") trips that and comes back
        # as an opaque "HTTP 403 ... error code: 1010" with no other detail.
        # A normal-looking UA is enough to pass; this changes nothing about
        # what's actually sent otherwise.
        "User-Agent": "Mozilla/5.0 (compatible; TraceX-GraphRAG/1.0; +https://github.com)",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "stream": False,
    }).encode("utf-8")

    attempt = 0
    while True:
        attempt += 1
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=GRAPH_RAG_TIMEOUT_SECONDS) as response:
                body = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            # Surface the provider's own error body (e.g. "invalid API key",
            # "model not found", rate limit) instead of a bare status code --
            # this is the fastest way to debug a misconfigured demo API key.
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:500]
            except Exception:  # noqa: BLE001 - best-effort detail only
                detail = str(exc)
            if exc.code in _RETRYABLE_HTTP_STATUSES and attempt <= GRAPH_RAG_LLM_MAX_RETRIES:
                time.sleep(GRAPH_RAG_LLM_RETRY_DELAY_SECONDS * attempt)
                continue
            raise LLMUnavailableError(f"HTTP {exc.code} from {url} (model={model}): {detail}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            # Covers connection refused/reset and read timeouts. Each
            # attempt here already waits up to GRAPH_RAG_TIMEOUT_SECONDS
            # before failing, so retry at most once (not
            # GRAPH_RAG_LLM_MAX_RETRIES times) and with no extra sleep --
            # otherwise a genuinely down endpoint can take minutes to fail
            # instead of seconds, before the fallback provider even gets a
            # turn.
            if attempt <= 1:
                continue
            raise LLMUnavailableError(f"could not reach {url} (model={model}): {exc}") from exc

    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMUnavailableError("the LLM returned an unexpected response shape") from exc
    if not text:
        raise LLMUnavailableError("the LLM returned an empty response")
    return text.strip()


def call_llm(prompt: str) -> tuple[str, str]:
    """Returns (answer_text, model_actually_used). Tries the primary
    provider (GRAPH_RAG_LLM_URL/MODEL/API_KEY) first, with retries on
    transient failures (429/503/timeout/connection errors). If it still
    fails, falls back once to a fully independent second provider
    (GRAPH_RAG_LLM_FALLBACK_URL/MODEL/API_KEY) so an outage on one vendor's
    infrastructure doesn't take the whole assistant down."""
    if not GRAPH_RAG_LLM_API_KEY:
        raise LLMUnavailableError(
            "GRAPH_RAG_LLM_API_KEY is not set. Add it to backend/.env (see backend/.env.example) "
            "and restart the backend."
        )
    try:
        return (
            _call_chat_completions(prompt, GRAPH_RAG_LLM_URL, GRAPH_RAG_LLM_MODEL, GRAPH_RAG_LLM_API_KEY),
            GRAPH_RAG_LLM_MODEL,
        )
    except LLMUnavailableError as primary_exc:
        if GRAPH_RAG_LLM_FALLBACK_URL and GRAPH_RAG_LLM_FALLBACK_MODEL:
            try:
                return (
                    _call_chat_completions(
                        prompt, GRAPH_RAG_LLM_FALLBACK_URL, GRAPH_RAG_LLM_FALLBACK_MODEL, GRAPH_RAG_LLM_FALLBACK_API_KEY
                    ),
                    GRAPH_RAG_LLM_FALLBACK_MODEL,
                )
            except LLMUnavailableError:
                pass
        raise primary_exc


# ---------------------------------------------------------------------------
# Citation validation: an answer may only cite IDs that were actually in its
# own context pack. Anything else is a hallucinated reference and is
# reported separately rather than presented as a verified source link.
# ---------------------------------------------------------------------------

_ID_RE = re.compile(r"\[([A-Za-z0-9_\-]+)\]")


def extract_and_validate_sources(answer_text: str, pack: ContextPack):
    known_ids = pack.entity_ids | pack.evidence_ids | pack.relationship_ids
    mentioned = set(_ID_RE.findall(answer_text))
    valid_sources = sorted(mentioned & known_ids)
    unverified_mentions = sorted(mentioned - known_ids)
    return valid_sources, unverified_mentions


# ---------------------------------------------------------------------------
# Source links: turns each verified [ID] citation into a concrete place in
# the app to go see it, so the frontend can render a real "view" button
# instead of an inert chip. This is deliberately computed here (not guessed
# from the ID's string shape on the frontend) because evidence IDs are not
# uniformly formatted across this dataset -- some cases use "E-CASE-..."
# and others "EVID-CASE-..." -- so pattern-matching the ID string is
# fragile; the backend already knows exactly what kind of thing each ID is.
# ---------------------------------------------------------------------------

def _resolve_source_links(valid_sources: list, pack: ContextPack, case_id: str, evidence_records: list) -> dict:
    """Returns {source_id: {kind, route, label, ...}} for each ID in
    valid_sources -- `label` is a short, human-readable answer to "where did
    this come from" (e.g. "First Information Report -- FIR-2026-00452", or
    "AI-predicted lead (no source document)"), meant to be shown next to the
    source chip itself rather than left for the investigator to infer from a
    bare ID like "R061".

    - entity ID -> that entity's detail page; label is the entity's name.
    - evidence ID -> straight to that record's original document view on
      the Evidence page (?evidenceId=... already auto-opens it there);
      label is the document's own title (e.g. "financial_statement.docx"
      for an uploaded file, or "Call Detail Record Analysis" for seed data).
    - CONFIRMED relationship ID -> resolved to whichever evidence record
      actually cites it (evidence.json's `relationship_ids` list is the
      reverse index for this) and routed/labeled the same way as an
      evidence ID -- that record's original document IS the source for
      this relationship.
    - PREDICTED relationship ID -> has no source document by definition; it's
      an AI-inferred graph-structure lead (see search_network()'s candidate
      scoring in main.py), not something extracted from a document. Routing
      it to a document would fabricate a citation that doesn't exist, so
      instead it points at the Network Explorer with the two entities/edge
      highlighted, using the same "trace on graph" sessionStorage handoff
      the Evidence page's own "Trace on graph" button already uses, and is
      labeled plainly as an AI lead rather than a document.
    - A confirmed relationship with no evidence record claiming it (data
      gap rather than the normal case) gets no route at all, reported
      honestly rather than guessed.
    """
    relationship_by_id = {rel["id"]: rel for rel in pack.relationships if rel.get("id")}
    entity_by_id = {entity["id"]: entity for entity in pack.entities if entity.get("id")}
    evidence_record_by_id = {record.get("id"): record for record in (evidence_records or []) if record.get("id")}
    evidence_by_relationship = {}
    for record in evidence_records or []:
        for rel_id in record.get("relationship_ids") or []:
            evidence_by_relationship.setdefault(rel_id, record.get("id"))

    def evidence_label(evidence_id):
        record = evidence_record_by_id.get(evidence_id) or {}
        return record.get("title") or record.get("type") or "Evidence document", record.get("source")

    links = {}
    for source_id in valid_sources:
        if source_id in pack.entity_ids:
            entity = entity_by_id.get(source_id) or {}
            links[source_id] = {
                "kind": "entity",
                "route": f"/entities/{source_id}",
                "label": entity.get("name") or source_id,
            }
            continue
        if source_id in pack.evidence_ids:
            label, document_source = evidence_label(source_id)
            links[source_id] = {
                "kind": "evidence",
                "route": f"/evidence?evidenceId={source_id}",
                "label": label,
                "document_source": document_source,
            }
            continue
        relationship = relationship_by_id.get(source_id)
        if relationship is None:
            continue
        if relationship.get("status") == "predicted":
            links[source_id] = {
                "kind": "predicted_relationship",
                "route": "/network",
                "trace": {
                    "caseId": case_id,
                    "nodeIds": [rid for rid in (relationship.get("source_id"), relationship.get("target_id")) if rid],
                    "edgeIds": [source_id],
                },
                "label": "AI-predicted lead (no source document)",
                "note": "AI-predicted lead based on graph structure -- no source document exists for this connection.",
            }
            continue
        evidence_id = evidence_by_relationship.get(source_id)
        if evidence_id:
            label, document_source = evidence_label(evidence_id)
            links[source_id] = {
                "kind": "evidence",
                "route": f"/evidence?evidenceId={evidence_id}",
                "via_relationship": True,
                "label": label,
                "document_source": document_source,
            }
        else:
            links[source_id] = {
                "kind": "relationship",
                "route": None,
                "label": "No linked evidence record",
                "note": "No linked evidence record found for this relationship.",
            }
    return links


# ---------------------------------------------------------------------------
# Entry point used by main.py
# ---------------------------------------------------------------------------

def generate_answer(
    query: str,
    case_id: str,
    search_result: dict,
    node_index: dict,
    network: dict | None = None,
    evidence_records: list | None = None,
    timeline_records: list | None = None,
    alerts_records: list | None = None,
) -> dict:
    """Returns an `assistant` object to merge into the existing
    search_network() response. Never raises: any failure (feature disabled,
    nothing retrieved, LLM unreachable) degrades to a clear
    `grounded: False` result with a plain-language `message`, so a request
    to /api/search/assistant never 500s just because the LLM call failed.

    `network`/`evidence_records`/`timeline_records`/`alerts_records` are the
    *unfiltered* case data (all of it, not just what search_network()
    happened to retrieve for this specific query) -- optional, but when the
    caller passes them and the targeted retrieval below comes up empty (the
    classifier in search_network() didn't recognize this question, found no
    entity, or the entities it found have no path between them), this falls
    back to build_full_case_pack() and still attempts an answer from a
    case-wide snapshot instead of refusing. That fallback is what lets the
    assistant field open-ended questions about the case as a whole, not just
    the ones search_network() has a specific handler for."""
    if not GRAPH_RAG_ENABLED:
        return {
            "enabled": False, "answer": None, "sources": [], "grounded": False,
            "message": "The AI investigation assistant is disabled on this server (GRAPH_RAG_ENABLED=false).",
        }

    status = search_result.get("status")
    # NO_CASE/ERROR mean there's no valid case/query to answer against at
    # all -- no amount of case-wide context helps there. Everything else
    # (including NO_MATCH/NO_PATH/AMBIGUOUS) is left to fall through to the
    # targeted pack below, and from there to the case-wide fallback if that
    # pack turns out empty.
    if status in ("NO_CASE", "ERROR"):
        return {
            "enabled": True, "answer": None, "sources": [], "grounded": False,
            "message": search_result.get("message") or "No matching graph context was found for this question.",
        }

    pack = build_context_pack(query, case_id, search_result, node_index or {})

    if network is not None and (status in ("NO_MATCH", "NO_PATH") or pack.is_empty()):
        pack = build_full_case_pack(
            query, case_id, network,
            evidence_records or [], timeline_records or [], alerts_records or [],
        )

    if pack.is_empty():
        return {
            "enabled": True, "answer": None, "sources": [], "grounded": False,
            "message": (
                "Insufficient evidence found in the available case data. "
                "No entities, relationships, evidence, or case notes were retrieved for this question."
            ),
        }

    try:
        raw_answer, model_used = call_llm(build_prompt(pack))
    except LLMUnavailableError as exc:
        return {
            "enabled": True, "answer": None, "sources": [], "grounded": False,
            "message": f"AI Investigation Assistant unavailable ({exc}). Showing graph results without a synthesized answer.",
        }

    valid_sources, unverified_mentions = extract_and_validate_sources(raw_answer, pack)
    # Prefer the full, unfiltered case evidence list (always passed by
    # main.py's /api/search/assistant handler) for the relationship->evidence
    # reverse lookup below, since pack.evidence may be capped/trimmed and a
    # cited relationship's owning record could fall outside that cap even
    # though the relationship itself was cited. Fall back to whatever
    # search_network() retrieved if the caller didn't pass the full list.
    source_links = _resolve_source_links(
        valid_sources, pack, case_id,
        evidence_records if evidence_records is not None else search_result.get("evidence"),
    )

    return {
        "enabled": True,
        "answer": raw_answer,
        "sources": valid_sources,
        "source_links": source_links,
        "grounded": True,
        "model": model_used,
        "full_case_context": pack.full_case,
        "context_entity_count": len(pack.entities),
        "context_relationship_count": len(pack.relationships),
        "context_evidence_count": len(pack.evidence),
        "context_note_count": len(pack.notes),
        "unverified_mentions": unverified_mentions or None,
    }


# ---------------------------------------------------------------------------
# Report executive summary -- used by reports.py (POST /api/reports/generate).
# Deliberately NOT a separate LLM integration: it reuses build_full_case_pack()
# for context assembly and call_llm() (with its existing retry/fallback-
# provider logic) for the actual request, exactly like generate_answer()
# above. Only the system prompt differs, because a report's executive
# summary is short third-person prose, not a Q&A-style cited answer.
# ---------------------------------------------------------------------------

REPORT_SYSTEM_INSTRUCTIONS = (
    "You are drafting the Executive Summary section of a formal police investigation "
    "report. Use ONLY the case data provided below -- entities, relationships, evidence, "
    "alerts, and timeline notes. Never invent people, relationships, events, "
    "transactions, or evidence, and never use outside/general world knowledge to fill in "
    "anything this data doesn't state. Clearly distinguish CONFIRMED relationships from "
    "PREDICTED/AI-inferred ones -- the data below tags each relationship '(PREDICTED / "
    "unconfirmed)' where that applies; do not present a predicted/similarity-based link "
    "as an established fact. Never state or imply that a named person is guilty of a "
    "crime -- describe findings neutrally, as investigative leads for a human "
    "investigator to corroborate. Write 3-6 sentences of formal, neutral, third-person "
    "investigative prose (no bullet points, no markdown, no headers, no bracketed "
    "citations) summarizing: what/who this case is investigating, the key entities and "
    "connections the case data shows, and the overall state of the evidence. If the data "
    "provided is too sparse to summarize meaningfully, respond with exactly this "
    "sentence and nothing else: \"Insufficient evidence found in the available case data "
    "to generate an executive summary.\""
)


def build_report_prompt(pack: ContextPack) -> str:
    return (
        f"{REPORT_SYSTEM_INSTRUCTIONS}\n\n"
        f"CASE DATA:\n{_format_context(pack)}\n\n"
        f"EXECUTIVE SUMMARY:"
    )


def generate_report_summary(
    case_id: str,
    network: dict,
    evidence_records: list,
    timeline_records: list,
    alerts_records: list,
    focus_entity_id: str | None = None,
) -> dict:
    """Returns {generated, text, model, message} for a report's AI executive
    summary. Always uses the case-wide snapshot (build_full_case_pack) since
    a report summarizes the whole investigation, not one query's targeted
    retrieval. Never raises -- on any failure (disabled, no data, LLM
    unreachable), `generated` is False and `message` explains why, so
    reports.build_report() can render that plainly instead of fabricating a
    summary."""
    if not GRAPH_RAG_ENABLED:
        return {
            "generated": False, "text": None, "model": None,
            "message": "AI executive summary is disabled on this server (GRAPH_RAG_ENABLED=false).",
        }

    query = f"Executive summary for case {case_id}" + (f", focused on {focus_entity_id}" if focus_entity_id else "")
    pack = build_full_case_pack(
        query, case_id, network or {}, evidence_records or [], timeline_records or [], alerts_records or [],
    )
    if pack.is_empty():
        return {
            "generated": False, "text": None, "model": None,
            "message": "Insufficient evidence found in the available case data to generate an executive summary.",
        }

    try:
        raw_text, model_used = call_llm(build_report_prompt(pack))
    except LLMUnavailableError as exc:
        return {
            "generated": False, "text": None, "model": None,
            "message": f"AI executive summary unavailable ({exc}).",
        }

    return {"generated": True, "text": raw_text, "model": model_used, "message": None}
