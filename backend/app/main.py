
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import hashlib
import json
import logging
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

from . import extraction

BASE = Path(__file__).resolve().parents[2]
DATA = BASE / "data"

def load(name):
    with open(DATA / name, "r", encoding="utf-8") as f:
        return json.load(f)

def load_network_for_case(case_id: str):
    network_path = DATA / "networks" / f"{case_id}.json"
    if not network_path.exists():
        raise HTTPException(status_code=404, detail="Network not found for case")

    with open(network_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Cross-case linking: the same phone number, account, vehicle, handle,
# organization, or person name recurring in more than one active case is a
# classic investigative lead ("is this the same person/number the Whitefield
# case already flagged?"). Every case's network is stored independently, so
# this is computed fresh on each /api/network request by matching entities
# across cases on the same normalized identity extraction already uses to
# de-duplicate mentions *within* one case. That's cheap at this app's scale
# (a handful of cases, at most a few hundred entities each) and always
# reflects whatever cases currently exist, including ones uploaded seconds
# ago -- no separate index to keep in sync.
# ---------------------------------------------------------------------------

# Only types that are meaningfully identifying are cross-referenced. PERSON
# and ORGANIZATION matches are name-only (no DOB/address to disambiguate),
# so they're presented as a lead worth checking, not a confirmed identity.
CROSS_CASE_LINK_TYPES = {"PHONE", "EMAIL", "ACCOUNT", "VEHICLE", "SOCIAL_ID", "ORGANIZATION", "PERSON"}


def _cross_case_index():
    """(type, normalized label) -> [{case_id, case_title, entity_id, label}, ...]
    across every case's stored network."""
    index = defaultdict(list)
    try:
        cases = load("cases.json")
    except FileNotFoundError:
        return index
    for case in cases:
        case_id = case.get("id")
        if not case_id:
            continue
        try:
            network_data = load_network_for_case(case_id)
        except HTTPException:
            continue
        for node in network_data.get("nodes", []):
            node_type = node.get("type")
            label = node.get("label")
            if node_type not in CROSS_CASE_LINK_TYPES or not label:
                continue
            key = (node_type, extraction._normalize_key(node_type, label))
            index[key].append({
                "case_id": case_id,
                "case_title": case.get("title", case_id),
                "entity_id": node.get("id"),
                "label": label,
            })
    return index


def attach_cross_case_matches(case_id: str, nodes: list) -> list:
    """Returns `nodes` with a `cross_case` field added to each: the entities
    from OTHER cases that share this node's identity, so the Network
    Explorer can flag "this phone/vehicle/account/org/name also appears in
    Case Y" directly on the graph."""
    index = _cross_case_index()
    enriched = []
    for node in nodes:
        node_type = node.get("type")
        label = node.get("label")
        matches = []
        if node_type in CROSS_CASE_LINK_TYPES and label:
            key = (node_type, extraction._normalize_key(node_type, label))
            for entry in index.get(key, ()):
                if entry["case_id"] == case_id or entry["entity_id"] == node.get("id"):
                    continue
                matches.append(entry)
        enriched.append({**node, "cross_case": matches})
    return enriched


def case_statistics(case_id: str):
    network = load_network_for_case(case_id)
    alerts_by_case = load("network_alerts.json")
    nodes = network.get("nodes", [])
    alerts = alerts_by_case.get(case_id, [])
    return {
        "entities": len({node.get("id") for node in nodes if node.get("id")}),
        "relationships": len(network.get("edges", [])),
        "alerts": len(alerts),
    }


def case_with_statistics(case):
    return {**case, **case_statistics(case["id"])}


CASE_ID_RE = re.compile(r"^CASE-(\d{4})-(\d+)$")


def generate_next_case_id(existing_cases):
    """Next CASE-<year>-<zero-padded-sequence> id, scanning all existing case
    ids (any year) for the highest sequence number so ids never collide even
    if the current year hasn't been used yet."""
    max_num = 0
    width = 5
    for case in existing_cases:
        match = CASE_ID_RE.match(str(case.get("id", "")))
        if match:
            width = max(width, len(match.group(2)))
            max_num = max(max_num, int(match.group(2)))
    year = datetime.now(timezone.utc).year
    return f"CASE-{year}-{str(max_num + 1).zfill(width)}"


class SemanticSearchRequest(BaseModel):
    query: str
    case_id: str | None = None


def load_optional_case_records(name: str, case_id: str):
    path = DATA / name
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)
    if isinstance(payload, dict):
        return payload.get(case_id, [])
    return payload


def evidence_for_selection(case_id: str, entity_id: str | None = None, relationship_id: str | None = None):
    records = load_optional_case_records("evidence.json", case_id)
    if entity_id:
        records = [record for record in records if entity_id in record.get("entity_ids", [record.get("entity_id")])]
    if relationship_id:
        records = [record for record in records if relationship_id in record.get("relationship_ids", [record.get("relationship_id")])]
    return records


def filter_timeline_records(records, query):
    if "last week" not in query:
        return records
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    filtered = []
    for record in records:
        timestamp = record.get("timestamp")
        if not timestamp:
            continue
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            if parsed >= cutoff:
                filtered.append(record)
        except (TypeError, ValueError):
            continue
    return filtered


def normalize_search_text(value: str) -> str:
    # \w is Unicode-aware in Python 3, so this keeps Devanagari (and other
    # non-Latin script) letters intact instead of stripping them to nothing --
    # the old ASCII-only [a-z0-9+] pattern silently broke search for any
    # non-English entity name (e.g. Hindi case data).
    return re.sub(r"\s+", " ", re.sub(r"[^\w+]+", " ", value.lower(), flags=re.UNICODE)).strip()


SEARCH_WEIGHTS = {
    "exact_match": 0.45,
    "semantic_similarity": 0.30,
    "entity_type_match": 0.15,
    "case_relevance": 0.10,
}
CONFIDENCE_THRESHOLDS = {"high": 0.85, "medium": 0.65}
SEARCH_LOGGER = logging.getLogger("sih26189.search")


def detect_intent(normalized_query: str):
    if re.search(r"\b2\s*hop\b|two hop|two-hop", normalized_query):
        return "TWO_HOP_QUERY", 0.98
    if any(phrase in normalized_query for phrase in (
        "summarize", "summary of", "case summary", "case overview", "overview of this case",
        "tell me about this case", "tell me about the case", "what is this case about",
        "what's this case about", "brief me", "case details", "give me a rundown",
        "walk me through this case",
    )):
        return "CASE_SUMMARY_QUERY", 0.95
    if any(phrase in normalized_query for phrase in (
        "predicted link", "predicted connection", "hidden link", "hidden connection",
        "ai suggested", "ai-suggested", "unconfirmed link", "possible connection",
        "suggested connection", "predicted lead", "predicted leads",
    )):
        return "PREDICTED_LINKS_QUERY", 0.95
    if any(phrase in normalized_query for phrase in ("how does", "how can", "how is", "path between", "connect to", "connected to")):
        return "PATH_QUERY", 0.94
    if any(word in normalized_query.split() for word in (
        "communicate", "communicates", "communicated", "communication", "call", "calls", "called",
        "message", "messages", "emailed", "text", "texted", "texting",
    )) or any(phrase in normalized_query for phrase in ("spoke to", "spoke with", "in touch with", "talked to", "talked with")):
        return "RELATIONSHIP_QUERY", 0.96
    if any(phrase in normalized_query for phrase in (
        "evidence", "documents", "document", "proof", "source document", "what proof",
    )):
        return "EVIDENCE_QUERY", 0.93
    if any(phrase in normalized_query for phrase in (
        "timeline", "what happened", "sequence of events", "chronology", "when did",
        "events in this case", "history of this case",
    )):
        return "TIMELINE_QUERY", 0.93
    if any(phrase in normalized_query for phrase in (
        "suspicious activity", "risk", "alert", "threat", "flagged", "danger", "dangerous", "warning",
    )):
        return "RISK_QUERY", 0.9
    if any(phrase in normalized_query for phrase in (
        "list all", "list every", "show all", "show me all", "who are the", "what are the",
        "give me all", "how many", "count of", "number of",
    )):
        return "LIST_QUERY", 0.9
    if "connected" in normalized_query.split() or "neighbors" in normalized_query.split():
        return "NEIGHBOR_QUERY", 0.96
    if any(phrase in normalized_query for phrase in ("give information", "tell me about", "show information", "what do you know", "investigate", "information on")):
        return "ENTITY_INFORMATION", 0.96
    return "GENERAL_SEARCH", 0.72


def extract_entity_mentions(normalized_query: str, nodes):
    mentions = []
    query_tokens = normalized_query.split()
    for node in nodes:
        name = normalize_search_text(node.get("label", ""))
        identifier = normalize_search_text(node["id"])
        if identifier and re.search(rf"\b{re.escape(identifier)}\b", normalized_query):
            mentions.append({"text": node["id"], "type": node.get("type", "UNKNOWN")})
            continue
        if not name:
            continue
        if name in normalized_query:
            mentions.append({"text": node.get("label", node["id"]), "type": node.get("type", "UNKNOWN")})
            continue
        # Require every significant word of the entity's name to appear in the query,
        # not just one shared token -- otherwise a common surname (e.g. "Verma") held
        # by several unrelated entities would flag all of them as "mentioned" from a
        # query that only names one of them.
        significant_tokens = [token for token in name.split() if len(token) > 2]
        if significant_tokens and all(token in query_tokens for token in significant_tokens):
            mentions.append({"text": node.get("label", node["id"]), "type": node.get("type", "UNKNOWN")})
    unique = {}
    for mention in mentions:
        unique[(mention["text"], mention["type"])] = mention
    return list(unique.values())


TYPE_KEYWORDS = {
    "PERSON": {"person", "people", "suspect", "suspects", "individual", "individuals", "accused", "victim", "victims", "witness", "witnesses"},
    "PHONE": {"phone", "phones", "number", "numbers", "mobile", "mobiles", "cellphone", "cellphones"},
    "VEHICLE": {"vehicle", "vehicles", "car", "cars", "bike", "bikes", "truck", "trucks"},
    "LOCATION": {"location", "locations", "place", "places", "address", "addresses"},
    "ORGANIZATION": {"organization", "organizations", "org", "orgs", "company", "companies", "firm", "firms"},
    "EVENT": {"event", "events", "incident", "incidents"},
    "ACCOUNT": {"account", "accounts"},
    "EMAIL": {"email", "emails"},
    "SOCIAL_ID": {"social", "handle", "handles"},
    "MONEY": {"money", "amount", "amounts", "transaction", "transactions", "fund", "funds"},
    "WEAPON": {"weapon", "weapons", "gun", "guns", "pistol", "pistols"},
    "DRUG": {"drug", "drugs", "narcotic", "narcotics"},
    "CRIME": {"crime", "crimes", "offense", "offence", "offenses"},
}


def detect_type_keyword(query_tokens):
    """Returns the entity_type a query is asking to enumerate/count, if any."""
    for entity_type, keywords in TYPE_KEYWORDS.items():
        if query_tokens & keywords:
            return entity_type
    return None


def normalize_confidence(value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    if 0 <= number <= 1:
        return round(number, 3)
    if 1 < number <= 100:
        return round(number / 100.0, 3)
    return None


def confidence_level(score: float):
    if score is None:
        return "LOW"
    if score >= CONFIDENCE_THRESHOLDS["high"]:
        return "HIGH"
    if score >= CONFIDENCE_THRESHOLDS["medium"]:
        return "MEDIUM"
    return "LOW"


def build_confidence(candidate, intent_type):
    factors = candidate["factors"]
    score = (
        SEARCH_WEIGHTS["exact_match"] * factors["exact_name_match"]
        + SEARCH_WEIGHTS["semantic_similarity"] * factors["semantic_similarity"]
        + SEARCH_WEIGHTS["entity_type_match"] * factors["entity_type_match"]
        + SEARCH_WEIGHTS["case_relevance"] * factors["case_relevance"]
    )
    if factors["exact_name_match"] == 1:
        score = max(score, 0.94)
    score = max(0.0, min(1.0, float(score)))
    return {
        "score": round(score, 3),
        "level": confidence_level(score),
        "factors": factors,
    }


def entity_result(node, score=1.0):
    normalized_score = normalize_confidence(score) or 0.0
    return {
        "id": node["id"],
        "name": node.get("label", node["id"]),
        "type": node.get("type", "UNKNOWN"),
        "score": round(normalized_score, 3),
    }


def relationship_result(edge):
    base_confidence = normalize_confidence(edge.get("confidence", 0)) or 0.0
    return {
        "id": edge["id"],
        "source": edge["source"],
        "target": edge["target"],
        "type": edge.get("type", "UNKNOWN"),
        "score": round(base_confidence, 3),
        "confidence": round(base_confidence, 3),
    }


def build_semantic_results(node_index, entities, relationships, query, intent_type):
    if not entities and not relationships:
        return []

    results = []
    for relationship in relationships:
        source_node = node_index.get(relationship.get("source"))
        target_node = node_index.get(relationship.get("target"))
        if not source_node or not target_node:
            continue
        confidence = normalize_confidence(relationship.get("confidence", relationship.get("score", 0))) or 0.0
        reason = (
            f"The query refers to the {relationship.get('type', 'relationship')} between "
            f"{source_node.get('label', source_node.get('id'))} and {target_node.get('label', target_node.get('id'))}."
        )
        if intent_type in {"RELATIONSHIP_QUERY", "PATH_QUERY"}:
            reason = (
                f"The query asks about the {relationship.get('type', 'relationship')} between "
                f"{source_node.get('label', source_node.get('id'))} and {target_node.get('label', target_node.get('id'))}."
            )
        results.append({
            "entity_id": source_node["id"],
            "entity_name": source_node.get("label", source_node["id"]),
            "entity_type": source_node.get("type", "UNKNOWN"),
            "relationship_id": relationship.get("id"),
            "relationship_type": relationship.get("type", "UNKNOWN"),
            "connected_entity_id": target_node["id"],
            "connected_entity_name": target_node.get("label", target_node["id"]),
            "confidence": round(confidence, 3),
            "reason": reason,
        })

    if not results:
        for entity in entities:
            results.append({
                "entity_id": entity["id"],
                "entity_name": entity.get("name", entity["id"]),
                "entity_type": entity.get("type", "UNKNOWN"),
                "relationship_id": None,
                "relationship_type": "DIRECT_CONNECTION",
                "connected_entity_id": None,
                "connected_entity_name": None,
                "confidence": round(normalize_confidence(entity.get("score", 0)) or 0.0, 3),
                "reason": f"The query matches the relevant entity {entity.get('name', entity['id'])} in the selected case network.",
            })

    return results


def find_shortest_path(source_id, target_id, edges):
    if source_id == target_id:
        return [source_id], []

    adjacency = {}
    for edge in edges:
        adjacency.setdefault(edge["source"], []).append((edge["target"], edge["id"]))
        adjacency.setdefault(edge["target"], []).append((edge["source"], edge["id"]))

    queue = [source_id]
    previous = {source_id: None}
    previous_edge = {}
    for current in queue:
        for neighbor_id, edge_id in adjacency.get(current, []):
            if neighbor_id in previous:
                continue
            previous[neighbor_id] = current
            previous_edge[neighbor_id] = edge_id
            queue.append(neighbor_id)
            if neighbor_id == target_id:
                queue = []
                break

    if target_id not in previous:
        return [], []

    path_nodes = []
    path_edges = []
    current = target_id
    while current is not None:
        path_nodes.append(current)
        if current in previous_edge:
            path_edges.append(previous_edge[current])
        current = previous[current]
    path_nodes.reverse()
    path_edges.reverse()
    return path_nodes, path_edges


NON_ENTITY_LIST_TOPICS = {
    "RELATIONSHIP": {"relationship", "relationships", "edge", "edges", "connection", "connections", "link", "links"},
    "ALERT": {"alert", "alerts", "finding", "findings", "flagged"},
    "EVIDENCE": {"evidence", "document", "documents", "source", "sources"},
    "EVENT": {"event", "events", "timeline", "happened", "history"},
}

STOPWORD_TOKENS = {
    "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "of", "in", "on", "at", "to",
    "for", "with", "and", "or", "this", "that", "case", "please", "can", "you", "me", "show", "tell",
    "what", "who", "which", "how", "give", "about", "any", "all",
}


def build_case_summary_response(base_response, nodes, edges, case_id):
    """Answers "summarize this case" / "what is this case about" style questions with
    a synthesized overview instead of requiring a named entity."""
    alerts = load_optional_case_records("network_alerts.json", case_id)
    confirmed = [edge for edge in edges if edge.get("status") != "predicted"]
    predicted = [edge for edge in edges if edge.get("status") == "predicted"]
    type_counts = {}
    for node in nodes:
        node_type = node.get("type", "UNKNOWN")
        type_counts[node_type] = type_counts.get(node_type, 0) + 1
    type_breakdown = ", ".join(
        f"{count} {etype.title()}" for etype, count in sorted(type_counts.items(), key=lambda kv: -kv[1])
    )
    top_alert = max(alerts, key=lambda item: item.get("score", 0)) if alerts else None
    summary_text = (
        f"This case has {len(nodes)} entities ({type_breakdown}) and {len(edges)} relationships "
        f"({len(confirmed)} confirmed, {len(predicted)} AI-predicted leads), with {len(alerts)} active alert(s)."
    )
    if top_alert:
        summary_text += f" Top flagged: {top_alert.get('title', top_alert.get('entity_id'))} ({top_alert.get('severity', 'INFO')})."
    base_response.update({
        "status": "SUCCESS",
        "message": None,
        "results": [{
            "entity_id": None,
            "entity_name": "Case summary",
            "entity_type": "CASE",
            "relationship_id": None,
            "relationship_type": "SUMMARY",
            "connected_entity_id": None,
            "connected_entity_name": None,
            "confidence": None,
            "reason": summary_text,
        }],
        "entities": [],
        "relationships": [],
        "alerts": alerts[:5],
        "summary": {"entity_count": len(nodes), "relationship_count": len(edges), "confidence": None},
        "graph_action": {"type": "NONE"},
    })
    return base_response


def build_list_response(base_response, nodes, entity_type):
    """Answers "list all vehicles" / "how many phone numbers" style questions by
    enumerating every entity of the named type, without needing a specific one named."""
    matches = [node for node in nodes if node.get("type") == entity_type]
    base_response.update({
        "status": "SUCCESS",
        "message": None if matches else f"No {entity_type.title()} entities are recorded in this case.",
        "entities": [entity_result(node, 1.0) for node in matches],
        "relationships": [],
        "results": [],
        "summary": {"entity_count": len(matches), "relationship_count": 0, "confidence": None},
        "graph_action": {"type": "HIGHLIGHT_ENTITIES", "entity_ids": [node["id"] for node in matches]},
    })
    return base_response


def build_all_relationships_response(base_response, edges):
    base_response.update({
        "status": "SUCCESS",
        "message": None if edges else "No relationships are recorded in this case.",
        "entities": [],
        "relationships": [relationship_result(edge) for edge in edges],
        "results": [],
        "summary": {"entity_count": 0, "relationship_count": len(edges), "confidence": None},
        "graph_action": {"type": "NONE"},
    })
    return base_response


def build_predicted_links_response(base_response, edges):
    predicted = [edge for edge in edges if edge.get("status") == "predicted"]
    base_response.update({
        "status": "SUCCESS",
        "message": None if predicted else "No AI-predicted connections are available for this case.",
        "entities": [],
        "relationships": [relationship_result(edge) for edge in predicted],
        "results": [],
        "summary": {"entity_count": 0, "relationship_count": len(predicted), "confidence": None},
        "graph_action": {
            "type": "HIGHLIGHT_RELATIONSHIP",
            "entity_ids": [],
            "relationship_ids": [edge["id"] for edge in predicted],
        },
    })
    return base_response


def build_evidence_response(base_response, case_id):
    records = load_optional_case_records("evidence.json", case_id)
    results = [{
        "entity_id": None,
        "entity_name": record.get("title", record.get("id")),
        "entity_type": record.get("type", "EVIDENCE"),
        "relationship_id": None,
        "relationship_type": "EVIDENCE",
        "connected_entity_id": None,
        "connected_entity_name": None,
        "confidence": normalize_confidence(record.get("confidence")),
        "reason": record.get("summary") or record.get("evidence_note") or f"Source: {record.get('source', 'unknown')}",
    } for record in records]
    base_response.update({
        "status": "SUCCESS",
        "message": None if results else "No evidence records are available for this case.",
        "entities": [],
        "relationships": [],
        "results": results,
        "evidence": records,
        "summary": {"entity_count": 0, "relationship_count": 0, "confidence": None},
        "graph_action": {"type": "NONE"},
    })
    return base_response


def build_timeline_response(base_response, case_id, normalized_query):
    records = filter_timeline_records(load_optional_case_records("timeline.json", case_id), normalized_query)
    results = [{
        "entity_id": None,
        "entity_name": record.get("title", record.get("id")),
        "entity_type": "EVENT",
        "relationship_id": None,
        "relationship_type": (record.get("timestamp") or "")[:10] or "EVENT",
        "connected_entity_id": None,
        "connected_entity_name": None,
        "confidence": None,
        "reason": record.get("description", ""),
    } for record in records]
    base_response.update({
        "status": "SUCCESS",
        "message": None if results else "No dated events are available for this case.",
        "entities": [],
        "relationships": [],
        "results": results,
        "timeline": records,
        "summary": {"entity_count": 0, "relationship_count": 0, "confidence": None},
        "graph_action": {"type": "NONE"},
    })
    return base_response


def build_alerts_response(base_response, case_id):
    alerts = load_optional_case_records("network_alerts.json", case_id)
    ranked = sorted(alerts, key=lambda item: item.get("score", 0), reverse=True)
    results = [{
        "entity_id": alert.get("entity_id"),
        "entity_name": alert.get("title", alert.get("entity_id")),
        "entity_type": "ALERT",
        "relationship_id": None,
        "relationship_type": f"{alert.get('severity', 'INFO')} ALERT",
        "connected_entity_id": None,
        "connected_entity_name": None,
        "confidence": normalize_confidence(alert.get("score")),
        "reason": (alert.get("reasons") or [alert.get("title", "")])[0],
    } for alert in ranked]
    base_response.update({
        "status": "SUCCESS",
        "message": None if results else "No alerts are currently flagged for this case.",
        "entities": [],
        "relationships": [],
        "results": results,
        "alerts": alerts,
        "summary": {"entity_count": 0, "relationship_count": 0, "confidence": None},
        "graph_action": {"type": "NONE"},
    })
    return base_response


def handle_generic_intent(intent_type, normalized_query, query_tokens, nodes, edges, case_id, base_response):
    """Answers case-wide questions that don't need (or didn't resolve) a named entity --
    the counterpart to the entity-anchored flow below, for "how many", "list all",
    "summarize this case", "what evidence do we have" style questions."""
    if intent_type == "CASE_SUMMARY_QUERY":
        return build_case_summary_response(base_response, nodes, edges, case_id)

    if intent_type == "PREDICTED_LINKS_QUERY":
        return build_predicted_links_response(base_response, edges)

    if intent_type == "EVIDENCE_QUERY":
        return build_evidence_response(base_response, case_id)

    if intent_type == "TIMELINE_QUERY":
        return build_timeline_response(base_response, case_id, normalized_query)

    if intent_type == "RISK_QUERY":
        return build_alerts_response(base_response, case_id)

    if intent_type in ("LIST_QUERY", "GENERAL_SEARCH"):
        entity_type = detect_type_keyword(query_tokens)
        if entity_type:
            return build_list_response(base_response, nodes, entity_type)
        if query_tokens & NON_ENTITY_LIST_TOPICS["RELATIONSHIP"]:
            if "predicted" in query_tokens or "hidden" in query_tokens or "unconfirmed" in query_tokens:
                return build_predicted_links_response(base_response, edges)
            return build_all_relationships_response(base_response, edges)
        if query_tokens & NON_ENTITY_LIST_TOPICS["ALERT"]:
            return build_alerts_response(base_response, case_id)
        if query_tokens & NON_ENTITY_LIST_TOPICS["EVIDENCE"]:
            return build_evidence_response(base_response, case_id)
        if query_tokens & NON_ENTITY_LIST_TOPICS["EVENT"]:
            return build_timeline_response(base_response, case_id, normalized_query)

    return None


def best_effort_search(normalized_query, query_tokens, case_id, base_response):
    """Last-resort lexical scan across alerts, evidence and timeline text when no
    entity was named and no specific intent matched -- so an unrecognized question
    still returns something relevant instead of a dead end."""
    meaningful_tokens = query_tokens - STOPWORD_TOKENS
    if not meaningful_tokens:
        return None

    scored = []

    for alert in load_optional_case_records("network_alerts.json", case_id):
        text = normalize_search_text(f"{alert.get('title', '')} {' '.join(alert.get('reasons', []))}")
        overlap = len(meaningful_tokens & set(text.split()))
        if overlap:
            scored.append((overlap, {
                "entity_id": alert.get("entity_id"),
                "entity_name": alert.get("title", alert.get("entity_id")),
                "entity_type": "ALERT",
                "relationship_id": None,
                "relationship_type": f"{alert.get('severity', 'INFO')} ALERT",
                "connected_entity_id": None,
                "connected_entity_name": None,
                "confidence": normalize_confidence(alert.get("score")),
                "reason": (alert.get("reasons") or [alert.get("title", "")])[0],
            }))

    for record in load_optional_case_records("evidence.json", case_id):
        text = normalize_search_text(f"{record.get('title', '')} {record.get('summary', '')}")
        overlap = len(meaningful_tokens & set(text.split()))
        if overlap:
            scored.append((overlap, {
                "entity_id": None,
                "entity_name": record.get("title", record.get("id")),
                "entity_type": record.get("type", "EVIDENCE"),
                "relationship_id": None,
                "relationship_type": "EVIDENCE",
                "connected_entity_id": None,
                "connected_entity_name": None,
                "confidence": normalize_confidence(record.get("confidence")),
                "reason": record.get("summary") or f"Source: {record.get('source', 'unknown')}",
            }))

    for record in load_optional_case_records("timeline.json", case_id):
        text = normalize_search_text(f"{record.get('title', '')} {record.get('description', '')}")
        overlap = len(meaningful_tokens & set(text.split()))
        if overlap:
            scored.append((overlap, {
                "entity_id": None,
                "entity_name": record.get("title", record.get("id")),
                "entity_type": "EVENT",
                "relationship_id": None,
                "relationship_type": "EVENT",
                "connected_entity_id": None,
                "connected_entity_name": None,
                "confidence": None,
                "reason": record.get("description", ""),
            }))

    if not scored:
        return None

    scored.sort(key=lambda item: item[0], reverse=True)
    top_results = [item for _, item in scored[:6]]
    base_response.update({
        "status": "SUCCESS",
        "message": "No exact match, but here's what's related to your query.",
        "entities": [],
        "relationships": [],
        "results": top_results,
        "summary": {"entity_count": 0, "relationship_count": 0, "confidence": None},
        "graph_action": {"type": "NONE"},
    })
    return base_response


def search_network(query: str, case_id: str):
    network = load_network_for_case(case_id)
    nodes = network.get("nodes", [])
    edges = network.get("edges", [])
    original_query = query
    normalized_query = normalize_search_text(query)
    intent_type, intent_confidence = detect_intent(normalized_query)
    node_index = {node["id"]: node for node in nodes}
    mentions = extract_entity_mentions(normalized_query, nodes)
    mention_texts = {normalize_search_text(mention["text"]) for mention in mentions}

    candidates = []
    query_tokens = set(normalized_query.split())
    generic_tokens = {
        "person", "phone", "vehicle", "location", "organization", "device", "account", "event",
        "give", "information", "tell", "me", "about", "show", "what", "do", "you", "know",
        "investigate", "on", "who", "is", "connected", "to", "the", "which", "people", "find",
    }
    semantic_query_tokens = query_tokens - generic_tokens
    for node in nodes:
        label = normalize_search_text(node.get("label", ""))
        identifier = normalize_search_text(node["id"])
        node_tokens = set(normalize_search_text(f"{label} {identifier} {node.get('type', '')}").split())
        exact = 1.0 if normalized_query in {label, identifier} or label in mention_texts or identifier in mention_texts else 0.0
        token_overlap = len(semantic_query_tokens.intersection(node_tokens)) / max(len(set(label.split())), 1)
        sequence = SequenceMatcher(None, normalized_query, label).ratio() if label else 0.0
        semantic_similarity = min(1.0, max(token_overlap, sequence * 0.8))
        type_match = 1.0 if node.get("type", "").lower() in query_tokens else 0.0
        if exact or semantic_similarity >= 0.32:
            candidate = {
                "node": node,
                "score": 0,
                "factors": {
                    "exact_name_match": exact,
                    "semantic_similarity": round(semantic_similarity, 2),
                    "entity_type_match": type_match,
                    "case_relevance": 1.0,
                },
            }
            candidate["confidence"] = build_confidence(candidate, intent_type)
            candidate["score"] = candidate["confidence"]["score"]
            candidates.append(candidate)

    candidates.sort(key=lambda item: item["score"], reverse=True)

    generic_when_unnamed = {
        "CASE_SUMMARY_QUERY", "LIST_QUERY", "EVIDENCE_QUERY", "TIMELINE_QUERY",
        "PREDICTED_LINKS_QUERY", "RISK_QUERY",
    }
    if not mentions and intent_type in generic_when_unnamed:
        # No entity was named, and this intent has a case-wide meaning
        # (e.g. "list all alerts") -- don't let a weak fuzzy name match
        # hijack it into an entity-resolution flow.
        candidates = []

    SEARCH_LOGGER.info("query=%r normalized=%r intent=%s candidates=%d", original_query, normalized_query, intent_type, len(candidates))

    base_response = {
        "query": original_query,
        "normalized_query": normalized_query,
        "case_id": case_id,
        "intent": {"type": intent_type, "confidence": intent_confidence},
        "extracted_entities": mentions,
        "entities": [],
        "connected_entities": [],
        "relationships": [],
        "results": [],
        "alternatives": [],
        "graph_action": {"type": "NONE"},
        "evidence": [],
        "timeline": [],
        "alerts": [],
        "summary": {"entity_count": 0, "relationship_count": 0, "confidence": None},
    }
    if "last week" in normalized_query:
        base_response["timeline_filter"] = "last week"
        base_response["timeline_message"] = "No timestamped records are available for this case." if not load_optional_case_records("timeline.json", case_id) else None
    if not candidates:
        generic = handle_generic_intent(intent_type, normalized_query, query_tokens, nodes, edges, case_id, base_response)
        if generic is not None:
            return generic
        fallback = best_effort_search(normalized_query, query_tokens, case_id, base_response)
        if fallback is not None:
            return fallback
        base_response.update({
            "status": "NO_MATCH",
            "message": (
                "No matching entity found. Try naming an entity (\"tell me about Suresh Verma\"), "
                "a category (\"list all vehicles\"), a relationship (\"who is connected to X\"), "
                "or the case as a whole (\"summarize this case\")."
            ),
        })
        return base_response

    ambiguous = intent_type in (
        "ENTITY_INFORMATION", "NEIGHBOR_QUERY", "RISK_QUERY", "GENERAL_SEARCH",
        "LIST_QUERY", "EVIDENCE_QUERY", "TIMELINE_QUERY", "PREDICTED_LINKS_QUERY", "CASE_SUMMARY_QUERY",
    ) and len(candidates) > 1 and candidates[0]["score"] < 0.94 and candidates[0]["score"] - candidates[1]["score"] <= 0.05
    if ambiguous:
        base_response.update({
            "status": "AMBIGUOUS",
            "message": "Multiple matching entities found. Select an entity to continue.",
            "candidates": [entity_result(item["node"], item["score"]) for item in candidates[:5]],
        })
        return base_response

    resolved = candidates[0]
    if mentions:
        first_mention = normalize_search_text(mentions[0]["text"])
        resolved = next(
            (candidate for candidate in candidates if normalize_search_text(candidate["node"].get("label", "")) == first_mention or normalize_search_text(candidate["node"]["id"]) == first_mention),
            resolved,
        )
    target = resolved["node"]
    target_id = target["id"]
    base_response.update({
        "status": "SUCCESS",
        "resolved_entity": entity_result(target, resolved["score"]),
        "confidence": resolved["confidence"],
        "alternatives": [entity_result(item["node"], item["score"]) for item in candidates[1:4]],
        "entities": [entity_result(target, resolved["score"])],
        "evidence": evidence_for_selection(case_id, entity_id=target_id),
        "alerts": [alert for alert in load_optional_case_records("network_alerts.json", case_id) if alert.get("entity_id") == target_id],
    })

    direct_edges = [edge for edge in edges if edge["source"] == target_id or edge["target"] == target_id]
    timeline_records = filter_timeline_records(load_optional_case_records("timeline.json", case_id), normalized_query)
    base_response["timeline"] = [
        record for record in timeline_records
        if target_id in record.get("entity_ids", [record.get("entity_id")])
    ]
    if intent_type == "TWO_HOP_QUERY":
        adjacency = {}
        for edge in edges:
            adjacency.setdefault(edge["source"], []).append(edge["target"])
            adjacency.setdefault(edge["target"], []).append(edge["source"])
        distance = {target_id: 0}
        queue = [target_id]
        for current in queue:
            if distance[current] >= 2:
                continue
            for neighbor_id in adjacency.get(current, []):
                if neighbor_id not in distance:
                    distance[neighbor_id] = distance[current] + 1
                    queue.append(neighbor_id)
        neighborhood_ids = set(distance)
        neighborhood_edges = [
            edge for edge in edges
            if edge["source"] in neighborhood_ids and edge["target"] in neighborhood_ids
            and max(distance[edge["source"]], distance[edge["target"]]) <= 2
        ]
        base_response["connected_entities"] = [
            entity_result(node_index[node_id]) for node_id in neighborhood_ids - {target_id} if node_id in node_index
        ]
        base_response["relationships"] = [relationship_result(edge) for edge in neighborhood_edges]
        base_response["graph_action"] = {
            "type": "HIGHLIGHT_TWO_HOP_NETWORK",
            "target_entity_id": target_id,
            "node_ids": list(neighborhood_ids),
            "relationship_ids": [edge["id"] for edge in neighborhood_edges],
        }
    elif intent_type == "PATH_QUERY":
        mentioned_ids = [
            node["id"] for node in nodes
            if normalize_search_text(node.get("label", "")) in mention_texts
            or normalize_search_text(node["id"]) in mention_texts
        ]
        if len(mentioned_ids) >= 2:
            path_node_ids, path_edge_ids = find_shortest_path(mentioned_ids[0], mentioned_ids[1], edges)
            if not path_node_ids:
                base_response.update({
                    "status": "NO_PATH",
                    "message": "No path found between the selected entities.",
                    "graph_action": {"type": "NONE"},
                })
                return base_response
            path_edges = [edge for edge in edges if edge["id"] in path_edge_ids]
            base_response["entities"] = [entity_result(node_index[node_id], resolved["score"]) for node_id in path_node_ids]
            base_response["relationships"] = [relationship_result(edge) for edge in path_edges]
            base_response["graph_action"] = {
                "type": "HIGHLIGHT_PATH",
                "entity_ids": path_node_ids,
                "relationship_ids": path_edge_ids,
            }
            base_response["evidence"] = [
                record for edge in path_edges
                for record in evidence_for_selection(case_id, relationship_id=edge["id"])
            ]
        else:
            # Only one entity was named ("who is connected to X") — a path needs two
            # endpoints, so fall back to showing that entity's direct connections
            # instead of returning an unhelpful "identify two entities" error.
            connected_ids = {
                edge["target"] if edge["source"] == target_id else edge["source"] for edge in direct_edges
            }
            base_response["connected_entities"] = [entity_result(node_index[node_id]) for node_id in connected_ids if node_id in node_index]
            base_response["relationships"] = [relationship_result(edge) for edge in direct_edges]
            base_response["evidence"] = [
                record
                for edge in direct_edges
                for record in evidence_for_selection(case_id, relationship_id=edge["id"])
            ]
            base_response["graph_action"] = {"type": "HIGHLIGHT_ENTITY_NEIGHBORHOOD", "target_entity_id": target_id}
    elif intent_type in (
        "ENTITY_INFORMATION", "NEIGHBOR_QUERY", "RISK_QUERY",
        "LIST_QUERY", "EVIDENCE_QUERY", "TIMELINE_QUERY", "PREDICTED_LINKS_QUERY", "CASE_SUMMARY_QUERY",
    ):
        connected_ids = {
            edge["target"] if edge["source"] == target_id else edge["source"] for edge in direct_edges
        }
        base_response["connected_entities"] = [entity_result(node_index[node_id]) for node_id in connected_ids if node_id in node_index]
        base_response["relationships"] = [relationship_result(edge) for edge in direct_edges]
        base_response["evidence"] = [
            record
            for edge in direct_edges
            for record in evidence_for_selection(case_id, relationship_id=edge["id"])
        ]
        base_response["graph_action"] = {"type": "HIGHLIGHT_ENTITY_NEIGHBORHOOD", "target_entity_id": target_id}
    elif intent_type in ("RELATIONSHIP_QUERY", "PATH_QUERY"):
        mentioned_ids = [node["id"] for node in nodes if normalize_search_text(node.get("label", "")) in mention_texts or normalize_search_text(node["id"]) in mention_texts]
        if len(mentioned_ids) < 2:
            mentioned_ids = [target_id]
        if len(mentioned_ids) == 1:
            relationship_edges = [edge for edge in edges if target_id in (edge["source"], edge["target"])]
        else:
            relationship_edges = [edge for edge in edges if edge["source"] in mentioned_ids and edge["target"] in mentioned_ids]
        if intent_type == "RELATIONSHIP_QUERY":
            communication_types = {"CALL", "MESSAGE", "EMAIL", "SMS", "CHAT", "CONTACT", "CONTACT_NUMBER", "CONTACT_EMAIL"}
            relationship_edges = [edge for edge in relationship_edges if edge.get("type", "").upper() in communication_types] or relationship_edges
            timeline_relationship_ids = {
                record.get("relationship_id") for record in timeline_records if record.get("relationship_id")
            }
            if timeline_relationship_ids:
                relationship_edges = [edge for edge in relationship_edges if edge["id"] in timeline_relationship_ids]
        base_response["entities"] = [entity_result(node_index[node_id], resolved["score"]) for node_id in mentioned_ids if node_id in node_index]
        base_response["relationships"] = [relationship_result(edge) for edge in relationship_edges]
        highlighted_node_ids = set(mentioned_ids)
        for edge in relationship_edges:
            highlighted_node_ids.add(edge["source"])
            highlighted_node_ids.add(edge["target"])
        base_response["connected_entities"] = [
            entity_result(node_index[node_id]) for node_id in highlighted_node_ids - set(mentioned_ids) if node_id in node_index
        ]
        base_response["graph_action"] = {
            "type": "HIGHLIGHT_RELATIONSHIP",
            "entity_ids": list(highlighted_node_ids),
            "relationship_ids": [edge["id"] for edge in relationship_edges],
        }
    else:
        base_response["graph_action"] = {"type": "HIGHLIGHT_ENTITY", "target_entity_id": target_id}

    base_response["results"] = build_semantic_results(
        node_index,
        base_response.get("entities", []),
        base_response.get("relationships", []),
        normalized_query,
        intent_type,
    )
    base_response["summary"] = {
        "entity_count": len(base_response.get("entities", [])),
        "relationship_count": len(base_response.get("relationships", [])),
        "confidence": normalize_confidence(base_response.get("confidence", {}).get("score", base_response.get("confidence"))) if isinstance(base_response.get("confidence", {}), dict) else normalize_confidence(base_response.get("confidence")),
    }
    SEARCH_LOGGER.info("resolved_entity=%s confidence=%.2f", target_id, base_response["summary"]["confidence"] or 0.0)
    return base_response

app = FastAPI(
    title="SIH 26189 Criminal Network Analysis API",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    return {"status": "ok", "service": "sih26189-api"}

@app.get("/api/dashboard")
def dashboard(case_id: str | None = None):
    case_inventory = load("cases.json")
    active_cases = sum(1 for case in case_inventory if case.get("status", "").strip().lower() == "active")
    high_priority_cases = sum(1 for case in case_inventory if case.get("priority", "").strip().lower() == "high")

    if not case_id:
        return {
            "case_id": None,
            "case_title": None,
            "active_cases": active_cases,
            "entities": 0,
            "relationships": 0,
            "alerts": 0,
            "high_priority_cases": high_priority_cases,
            "high_priority": False,
        }

    for case in case_inventory:
        if case["id"] == case_id:
            statistics = case_statistics(case_id)
            is_high_priority = case["priority"] == "High"
            return {
                "case_id": case_id,
                "case_title": case["title"],
                "active_cases": active_cases,
                **statistics,
                "high_priority_cases": high_priority_cases,
                "high_priority": is_high_priority,
            }

    raise HTTPException(status_code=404, detail="Case not found")

@app.get("/api/cases")
def cases():
    return [case_with_statistics(case) for case in load("cases.json")]

@app.get("/api/cases/{case_id}")
def case_detail(case_id: str):
    for case in load("cases.json"):
        if case["id"] == case_id:
            return case_with_statistics(case)
    raise HTTPException(status_code=404, detail="Case not found")


UPLOAD_ALLOWED_EXTENSIONS = {".pdf", ".txt", ".csv", ".docx", ".json", ".md"}
UPLOAD_MAX_FILES = 15
UPLOAD_MAX_FILE_BYTES = 15 * 1024 * 1024  # 15MB per file
UPLOAD_ALLOWED_PRIORITIES = {"Low", "Medium", "High"}
UPLOAD_ALLOWED_STATUSES = {"Active", "Under Review", "Closed", "Pending"}


def _write_json(path: Path, payload) -> None:
    with open(path, "w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2, ensure_ascii=False)


def _load_case_scoped_store(name: str) -> dict:
    path = DATA / name
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)
    return payload if isinstance(payload, dict) else {}


@app.post("/api/cases/upload")
async def upload_case(
    title: str = Form(...),
    priority: str = Form("Medium"),
    status: str = Form("Active"),
    files: list[UploadFile] = File(...),
):
    """Create a brand-new case from freshly uploaded documents (PDF/TXT/CSV/
    DOCX/JSON/MD), running the rule-based extractor in extraction.py
    synchronously so the case is immediately explorable -- no offline
    pipeline run required. See extraction.py's module docstring for what
    this is (and isn't)."""
    clean_title = (title or "").strip()
    if not clean_title:
        raise HTTPException(status_code=400, detail="Case title is required")
    if priority not in UPLOAD_ALLOWED_PRIORITIES:
        raise HTTPException(status_code=400, detail=f"Priority must be one of {sorted(UPLOAD_ALLOWED_PRIORITIES)}")
    if status not in UPLOAD_ALLOWED_STATUSES:
        raise HTTPException(status_code=400, detail=f"Status must be one of {sorted(UPLOAD_ALLOWED_STATUSES)}")
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required")
    if len(files) > UPLOAD_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"Too many files (max {UPLOAD_MAX_FILES} per upload)")

    documents = []
    seen_filenames = set()
    for upload in files:
        filename = (upload.filename or "").strip() or "document"
        base_filename = filename
        suffix = 2
        while base_filename in seen_filenames:
            base_filename = f"{filename} ({suffix})"
            suffix += 1
        seen_filenames.add(base_filename)

        ext = Path(filename).suffix.lower()
        if ext not in UPLOAD_ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type for {filename} (allowed: {', '.join(sorted(UPLOAD_ALLOWED_EXTENSIONS))})",
            )

        raw = await upload.read()
        if not raw:
            raise HTTPException(status_code=400, detail=f"{filename} is empty")
        if len(raw) > UPLOAD_MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail=f"{filename} exceeds the 15MB per-file upload limit")

        try:
            text = extraction.extract_text(filename, raw, ext)
        except extraction.ExtractionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        documents.append({
            "filename": base_filename,
            "ext": ext,
            "text": text,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "size": len(raw),
        })

    cases_store = load("cases.json")
    new_case_id = generate_next_case_id(cases_store)

    built = extraction.build_case_from_documents(new_case_id, documents)

    (DATA / "networks").mkdir(parents=True, exist_ok=True)
    _write_json(DATA / "networks" / f"{new_case_id}.json", {
        "nodes": built["nodes"],
        "edges": built["edges"],
    })

    evidence_store = _load_case_scoped_store("evidence.json")
    evidence_store[new_case_id] = built["evidence"]
    _write_json(DATA / "evidence.json", evidence_store)

    timeline_store = _load_case_scoped_store("timeline.json")
    timeline_store[new_case_id] = built["timeline"]
    _write_json(DATA / "timeline.json", timeline_store)

    alerts_store = _load_case_scoped_store("network_alerts.json")
    alerts_store[new_case_id] = built["alerts"]
    _write_json(DATA / "network_alerts.json", alerts_store)

    new_case = {
        "id": new_case_id,
        "title": clean_title,
        "status": status,
        "priority": priority,
        "entities": len(built["nodes"]),
        "relationships": len(built["edges"]),
        "alerts": len(built["alerts"]),
    }
    cases_store.append(new_case)
    _write_json(DATA / "cases.json", cases_store)

    try:
        logs = load_audit_logs()
        logs.append({
            "id": f"AUDIT-{new_case_id}-UPLOAD",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "action": "CREATE_CASE_FROM_UPLOAD",
            "case_id": new_case_id,
            "metadata": {
                "title": clean_title,
                "file_count": len(documents),
                "filenames": [doc["filename"] for doc in documents],
            },
        })
        save_audit_logs(logs)
    except Exception:  # noqa: BLE001 - audit logging must never block case creation
        logging.getLogger(__name__).exception("Failed to write audit log for case upload")

    return case_with_statistics(new_case)

@app.get("/api/entities")
def entities(case_id: str | None = None):
    if not case_id:
        return load("entities.json")

    network = load_network_for_case(case_id)
    return [
        {
            "id": node["id"],
            "type": node["type"],
            "name": node["label"],
            "confidence": node.get("confidence", 0),
            "community": node.get("community", 0),
            "centrality": node.get("centrality", 0),
        }
        for node in network.get("nodes", [])
    ]

@app.get("/api/entities/{entity_id}")
def entity(entity_id: str):
    for entity in load("entities.json"):
        if entity["id"] == entity_id:
            return entity
    raise HTTPException(status_code=404, detail="Entity not found")

@app.get("/api/network")
def network(case_id: str | None = None):
    if not case_id:
        return load("network.json")
    payload = load_network_for_case(case_id)
    return {**payload, "nodes": attach_cross_case_matches(case_id, payload.get("nodes", []))}


@app.post("/api/search/semantic")
def semantic_search(request: SemanticSearchRequest):
    if not request.query.strip():
        return {
            "query": request.query,
            "normalized_query": "",
            "case_id": request.case_id,
            "status": "ERROR",
            "intent": {"type": "GENERAL_SEARCH", "confidence": 0.0},
            "entities": [],
            "connected_entities": [],
            "relationships": [],
            "message": "Enter an investigation query.",
        }
    if not request.case_id:
        return {
            "query": request.query,
            "normalized_query": normalize_search_text(request.query),
            "case_id": None,
            "status": "NO_CASE",
            "intent": {"type": "GENERAL_SEARCH", "confidence": 0.0},
            "entities": [],
            "connected_entities": [],
            "relationships": [],
            "graph_action": {"type": "NONE"},
            "message": "Select a case before running semantic search.",
        }
    return search_network(request.query, request.case_id)


@app.get("/api/evidence")
def evidence(case_id: str | None = None, entity_id: str | None = None, relationship_id: str | None = None):
    if case_id:
        load_network_for_case(case_id)
    records = load_optional_case_records("evidence.json", case_id) if case_id else []
    if not case_id:
        all_records = []
        payload = load("evidence.json")
        for case_records in payload.values():
            all_records.extend(case_records)
        records = all_records
    if entity_id:
        records = [record for record in records if entity_id in record.get("entity_ids", [record.get("entity_id")])]
    if relationship_id:
        records = [record for record in records if relationship_id in record.get("relationship_ids", [record.get("relationship_id")])]
    return {
        "case_id": case_id,
        "records": records,
        "message": "No evidence records are available for this synthetic dataset." if not records else None,
    }


@app.get("/api/evidence/{evidence_id}")
def evidence_detail(evidence_id: str):
    payload = load("evidence.json")
    for case_records in payload.values():
        for record in case_records:
            if record.get("id") == evidence_id:
                return record
    raise HTTPException(status_code=404, detail="Evidence record not found")


class EvidenceVerificationRequest(BaseModel):
    status: str


@app.post("/api/evidence/{evidence_id}/verify")
def verify_evidence(evidence_id: str, payload: EvidenceVerificationRequest):
    if payload.status not in {"PENDING", "VERIFIED", "REQUIRES_REVIEW"}:
        raise HTTPException(status_code=400, detail="Invalid verification status")

    evidence_store = load("evidence.json")
    for case_records in evidence_store.values():
        for record in case_records:
            if record.get("id") == evidence_id:
                record["verification_status"] = payload.status
                with open(DATA / "evidence.json", "w", encoding="utf-8") as file:
                    json.dump(evidence_store, file, indent=2)
                return {
                    "id": evidence_id,
                    "verification_status": payload.status,
                    "status": "updated",
                    "message": "Evidence verification status updated after explicit user action.",
                }
    raise HTTPException(status_code=404, detail="Evidence record not found")

@app.get("/api/alerts")
def alerts(case_id: str | None = None):
    if not case_id:
        return load("alerts.json")

    return load("network_alerts.json").get(case_id, [])

@app.get("/api/alerts/{alert_id}")
def alert(alert_id: str):
    for item in load("alerts.json"):
        if item["id"] == alert_id:
            return item
    raise HTTPException(status_code=404, detail="Alert not found")

@app.get("/api/timeline")
def timeline(case_id: str | None = None):
    if not case_id:
        return {"case_id": None, "events": [], "message": "Select a case to view its timeline."}
    events = load_optional_case_records("timeline.json", case_id)
    return {"case_id": case_id, "events": events}


AUDIT_LOGS_PATH = DATA / "audit_logs.json"
ACTIVITY_SESSIONS_PATH = DATA / "activity_sessions.json"
ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS = 60


def load_audit_logs():
    if not AUDIT_LOGS_PATH.exists():
        AUDIT_LOGS_PATH.write_text("[]", encoding="utf-8")
    with open(AUDIT_LOGS_PATH, "r", encoding="utf-8") as file:
        payload = json.load(file)
    return payload if isinstance(payload, list) else []


def save_audit_logs(logs):
    with open(AUDIT_LOGS_PATH, "w", encoding="utf-8") as file:
        json.dump(logs, file, indent=2)


def load_activity_sessions():
    if not ACTIVITY_SESSIONS_PATH.exists():
        ACTIVITY_SESSIONS_PATH.write_text("[]", encoding="utf-8")
    with open(ACTIVITY_SESSIONS_PATH, "r", encoding="utf-8") as file:
        payload = json.load(file)
    return payload if isinstance(payload, list) else []


def save_activity_sessions(sessions):
    with open(ACTIVITY_SESSIONS_PATH, "w", encoding="utf-8") as file:
        json.dump(sessions, file, indent=2)


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def session_duration_seconds(session, now=None):
    started = parse_timestamp(session.get("login_at"))
    if not started:
        return 0
    ended = (
        parse_timestamp(session.get("logout_at"))
        or parse_timestamp(session.get("expired_at"))
        or now
        or datetime.now(timezone.utc)
    )
    return max(0, int((ended - started).total_seconds()))


def expire_stale_sessions(sessions):
    now = datetime.now(timezone.utc)
    changed = False
    for session in sessions:
        if session.get("status") != "ACTIVE":
            continue
        last_activity = parse_timestamp(session.get("last_activity_at"))
        if last_activity and (now - last_activity).total_seconds() > ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS:
            session["status"] = "EXPIRED"
            session["expired_at"] = now.isoformat().replace("+00:00", "Z")
            session["duration_seconds"] = session_duration_seconds(session, now)
            changed = True
    if changed:
        save_activity_sessions(sessions)
    return sessions


class AuditLogEntry(BaseModel):
    officer_id: str | None = None
    role: str = "investigator"
    action: str = "VIEW_CASE"
    case_id: str | None = None
    target_id: str | None = None
    session_id: str | None = None
    metadata: dict = {}


@app.get("/api/audit-logs")
def audit_logs(case_id: str | None = None):
    logs = load_audit_logs()
    if case_id:
        logs = [entry for entry in logs if entry.get("case_id") == case_id]
    return sorted(logs, key=lambda entry: entry.get("timestamp", ""), reverse=True)


@app.post("/api/audit-logs")
def create_audit_log(entry: AuditLogEntry):
    logs = load_audit_logs()
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    record = {
        "timestamp": timestamp,
        "officer_id": entry.officer_id,
        "role": entry.role,
        "action": entry.action,
        "case_id": entry.case_id,
        "target_id": entry.target_id,
        "session_id": entry.session_id,
        "metadata": entry.metadata,
    }
    logs.append(record)
    save_audit_logs(logs)
    if entry.session_id:
        sessions = expire_stale_sessions(load_activity_sessions())
        for session in sessions:
            if session.get("session_id") == entry.session_id and session.get("status") == "ACTIVE":
                session["last_activity_at"] = timestamp
                session["action_count"] = int(session.get("action_count", 0)) + 1
                if entry.case_id and entry.case_id not in session.setdefault("case_ids", []):
                    session["case_ids"].append(entry.case_id)
                session.setdefault("pages", [])
                if entry.action not in session["pages"]:
                    session["pages"].append(entry.action)
                save_activity_sessions(sessions)
                break
    return record


@app.post("/api/activity/event")
def create_activity_event(entry: AuditLogEntry):
    return create_audit_log(entry)


class ActivitySessionRequest(BaseModel):
    officer_id: str
    role: str = "investigator"
    session_id: str | None = None


class ActivityHeartbeatRequest(BaseModel):
    session_id: str
    officer_id: str


@app.post("/api/activity/session/login")
def activity_session_login(payload: ActivitySessionRequest):
    if payload.role != "investigator":
        raise HTTPException(status_code=403, detail="Only investigator sessions are monitored")
    sessions = expire_stale_sessions(load_activity_sessions())
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    session_id = payload.session_id or f"SESSION-{payload.officer_id}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    record = {
        "session_id": session_id,
        "officer_id": payload.officer_id,
        "role": payload.role,
        "login_at": timestamp,
        "logout_at": None,
        "expired_at": None,
        "status": "ACTIVE",
        "last_activity_at": timestamp,
        "duration_seconds": 0,
        "action_count": 0,
        "case_ids": [],
        "pages": [],
    }
    sessions.append(record)
    save_activity_sessions(sessions)
    return record


@app.post("/api/activity/session/logout")
def activity_session_logout(payload: ActivitySessionRequest):
    sessions = load_activity_sessions()
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for session in sessions:
        if session.get("session_id") == payload.session_id and session.get("officer_id") == payload.officer_id:
            if session.get("status") == "COMPLETED":
                return session
            if session.get("status") == "EXPIRED":
                return session
            session["logout_at"] = timestamp
            session["last_activity_at"] = timestamp
            session["status"] = "COMPLETED"
            session["duration_seconds"] = session_duration_seconds(session)
            session["action_count"] = int(session.get("action_count", 0)) + 1
            session.setdefault("pages", [])
            if "LOGOUT" not in session["pages"]:
                session["pages"].append("LOGOUT")
            other_sessions = [item for item in sessions if item is not session]
            expire_stale_sessions(other_sessions)
            save_activity_sessions(sessions)
            return session
    raise HTTPException(status_code=404, detail="Activity session not found")


@app.post("/api/activity/heartbeat")
def activity_heartbeat(payload: ActivityHeartbeatRequest):
    sessions = expire_stale_sessions(load_activity_sessions())
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for session in sessions:
        if session.get("session_id") == payload.session_id and session.get("officer_id") == payload.officer_id:
            if session.get("status") == "ACTIVE":
                session["last_activity_at"] = timestamp
                session["duration_seconds"] = session_duration_seconds(session)
                save_activity_sessions(sessions)
            return session
    raise HTTPException(status_code=404, detail="Activity session not found")


def enriched_activity_sessions():
    sessions = expire_stale_sessions(load_activity_sessions())
    events = load_audit_logs()
    server_now = datetime.now(timezone.utc)
    for session in sessions:
        if session.get("status") == "ACTIVE":
            session["duration_seconds"] = session_duration_seconds(session, server_now)
        session["activities"] = sorted(
            [event for event in events if event.get("session_id") == session.get("session_id")],
            key=lambda event: event.get("timestamp", ""),
            reverse=True,
        )
    return {
        "server_time": server_now.isoformat().replace("+00:00", "Z"),
        "heartbeat_timeout_seconds": ACTIVITY_HEARTBEAT_TIMEOUT_SECONDS,
        "sessions": sorted(sessions, key=lambda item: item.get("login_at", ""), reverse=True),
    }


@app.get("/api/activity/sessions")
def activity_sessions():
    return enriched_activity_sessions()


@app.get("/api/activity/active")
def active_activity_sessions():
    return [session for session in enriched_activity_sessions()["sessions"] if session.get("status") == "ACTIVE"]


@app.get("/api/activity/sessions/{session_id}")
def activity_session_detail(session_id: str):
    for session in enriched_activity_sessions()["sessions"]:
        if session.get("session_id") == session_id:
            return session
    raise HTTPException(status_code=404, detail="Activity session not found")


@app.get("/api/activity/officer/{officer_id}")
def officer_activity(officer_id: str):
    return [session for session in enriched_activity_sessions()["sessions"] if session.get("officer_id") == officer_id]
