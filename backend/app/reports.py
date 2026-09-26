"""
Report generation service for TraceX (POST /api/reports/generate).

This module does NOT load or re-derive case data itself -- exactly like
graph_rag.py, it only formats what main.py already loaded through the
existing loaders (load_network_for_case, load_optional_case_records) and the
existing find_shortest_path() BFS in main.py (reused for connection_paths,
which the caller computes and passes in). There is no second data pipeline,
no second graph-traversal implementation, and no second LLM integration --
the AI executive summary reuses graph_rag.generate_report_summary(), which
itself reuses graph_rag.build_full_case_pack() and graph_rag.call_llm().

Design constraints (mirrors graph_rag.py and the rest of this app):
  - Never invents an entity, relationship, event, or evidence record that
    isn't present in the data passed in by main.py.
  - Confirmed and predicted/AI-inferred relationships are always kept and
    labeled separately (see build_relationship_split), never merged into one
    undifferentiated list.
  - When a section has no underlying data, the report says so explicitly
    (see build_limitations) instead of silently omitting it or padding it
    with invented content.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

from . import graph_rag

# How much of the case goes into each report section -- independent knobs so
# a large case doesn't produce an unreadable (or, for the PDF, unbounded)
# report. Overridable via env for the same reason graph_rag's caps are.


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


REPORT_MAX_KEY_ENTITIES = _env_int("REPORT_MAX_KEY_ENTITIES", 8)
REPORT_MAX_RELATIONSHIPS_PER_STATUS = _env_int("REPORT_MAX_RELATIONSHIPS_PER_STATUS", 40)
REPORT_MAX_EVIDENCE = _env_int("REPORT_MAX_EVIDENCE", 20)
REPORT_MAX_ALERTS = _env_int("REPORT_MAX_ALERTS", 15)
REPORT_MAX_TIMELINE = _env_int("REPORT_MAX_TIMELINE", 30)


def _entity_brief(node: dict) -> dict:
    return {
        "id": node.get("id"),
        "name": node.get("label", node.get("id")),
        "type": node.get("type", "UNKNOWN"),
        "centrality": node.get("centrality"),
        "confidence": node.get("confidence"),
    }


def _relationship_brief(edge: dict, node_index: dict) -> dict:
    source_id = edge.get("source")
    target_id = edge.get("target")
    is_predicted = edge.get("status") == "predicted" or edge.get("type") == "PREDICTED"
    return {
        "id": edge.get("id"),
        "source_id": source_id,
        "source_name": node_index.get(source_id, {}).get("label", source_id),
        "target_id": target_id,
        "target_name": node_index.get(target_id, {}).get("label", target_id),
        "type": edge.get("type", "UNKNOWN"),
        "confidence": edge.get("confidence"),
        "status": "predicted" if is_predicted else "confirmed",
        "evidence_text": edge.get("evidence_text"),
        "source_document_id": edge.get("source_document_id"),
    }


def build_key_entities(primary_id, nodes, edges, node_index):
    """Entities directly connected to the investigated/primary entity,
    ranked by relationship confidence -- the report's "Key Connected
    Entities" section. Each carries the specific relationship that connects
    it to the primary entity, so the report can show why it's included."""
    if not primary_id:
        return []
    direct_edges = [edge for edge in edges if primary_id in (edge.get("source"), edge.get("target"))]
    ranked = sorted(direct_edges, key=lambda edge: edge.get("confidence") or 0, reverse=True)
    seen = set()
    key_entities = []
    for edge in ranked:
        other_id = edge["target"] if edge["source"] == primary_id else edge["source"]
        if other_id in seen or other_id not in node_index:
            continue
        seen.add(other_id)
        entity = _entity_brief(node_index[other_id])
        entity["relationship_to_primary"] = _relationship_brief(edge, node_index)
        key_entities.append(entity)
        if len(key_entities) >= REPORT_MAX_KEY_ENTITIES:
            break
    return key_entities


def build_relationship_split(edges, node_index):
    """Every relationship in the case's network, split into CONFIRMED and
    PREDICTED/AI-inferred lists -- report section "Confirmed vs Predicted
    Relationships". Never merges the two; a predicted link never counts
    toward the confirmed total or vice versa."""
    confirmed, predicted = [], []
    for edge in edges:
        brief = _relationship_brief(edge, node_index)
        (predicted if brief["status"] == "predicted" else confirmed).append(brief)
    confirmed.sort(key=lambda rel: rel.get("confidence") or 0, reverse=True)
    predicted.sort(key=lambda rel: rel.get("confidence") or 0, reverse=True)
    return {
        "confirmed": confirmed[:REPORT_MAX_RELATIONSHIPS_PER_STATUS],
        "confirmed_total": len(confirmed),
        "predicted": predicted[:REPORT_MAX_RELATIONSHIPS_PER_STATUS],
        "predicted_total": len(predicted),
    }


def build_network_summary(nodes, edges, relationship_split):
    type_counts: dict[str, int] = {}
    for node in nodes:
        node_type = node.get("type", "UNKNOWN")
        type_counts[node_type] = type_counts.get(node_type, 0) + 1
    communities = {node.get("community") for node in nodes if node.get("community") is not None}
    return {
        "entity_count": len(nodes),
        "relationship_count": len(edges),
        "confirmed_relationship_count": relationship_split["confirmed_total"],
        "predicted_relationship_count": relationship_split["predicted_total"],
        "entity_type_breakdown": sorted(type_counts.items(), key=lambda kv: -kv[1]),
        "community_count": len(communities),
    }


def build_evidence_section(evidence_records):
    """Report section "Supporting Evidence" -- source document, evidence
    text, and timestamp (when available) for each record, exactly as
    already stored in evidence.json. Nothing here is synthesized."""
    formatted = [{
        "id": record.get("id"),
        "type": record.get("type", "EVIDENCE"),
        "title": record.get("title") or record.get("id"),
        "source": record.get("source", "Unknown source"),
        "timestamp": record.get("timestamp"),
        "summary": record.get("summary") or record.get("evidence_note") or "",
        "verification_status": record.get("verification_status", "PENDING"),
        "entity_ids": record.get("entity_ids", []),
    } for record in evidence_records[:REPORT_MAX_EVIDENCE]]
    return {"records": formatted, "total": len(evidence_records)}


def build_alerts_section(alerts_records):
    ranked = sorted(alerts_records, key=lambda alert: alert.get("score") or 0, reverse=True)
    formatted = [{
        "id": alert.get("id"),
        "title": alert.get("title"),
        "entity_id": alert.get("entity_id"),
        "severity": alert.get("severity", "INFO"),
        "score": alert.get("score"),
        "reasons": alert.get("reasons", []),
    } for alert in ranked[:REPORT_MAX_ALERTS]]
    return {"records": formatted, "total": len(alerts_records)}


def build_timeline_section(timeline_records):
    ordered = sorted(timeline_records, key=lambda event: event.get("timestamp") or "")
    formatted = [{
        "id": event.get("id"),
        "timestamp": event.get("timestamp"),
        "title": event.get("title"),
        "description": event.get("description", ""),
        "entity_ids": event.get("entity_ids", []),
        "source_document_id": event.get("source_document_id"),
    } for event in ordered[:REPORT_MAX_TIMELINE]]
    return {"records": formatted, "total": len(timeline_records)}


def build_limitations(primary_id, evidence_records, timeline_records, relationship_split, ai_summary):
    """Report section "Investigation Limitations / Insufficient Evidence" --
    plainly states every gap this report actually has, rather than padding
    over them. Always includes the predicted-relationship count so a reader
    never mistakes an AI-suggested lead for a confirmed fact just because it
    appeared in a formal report."""
    limitations = []
    if not primary_id:
        limitations.append("No entities are available in this case's network graph.")
    if not evidence_records:
        limitations.append("No supporting evidence records are available for this case.")
    if not timeline_records:
        limitations.append("No dated timeline events are available for this case.")
    if relationship_split["predicted_total"]:
        limitations.append(
            f"{relationship_split['predicted_total']} relationship(s) in this case are AI-predicted "
            "leads based on graph structure/similarity, not confirmed facts -- they require human "
            "corroboration before being relied upon."
        )
    if not ai_summary.get("generated"):
        limitations.append(
            ai_summary.get("message") or "Insufficient evidence found in the available case data."
        )
    return limitations


def build_report(
    case: dict,
    network: dict,
    evidence_records: list,
    timeline_records: list,
    alerts_records: list,
    connection_paths: list,
    primary_entity_id: str | None,
    generated_by: str | None,
) -> dict:
    """Assembles the full report payload. All graph/evidence/alert/timeline
    data is passed in by main.py's /api/reports/generate -- already loaded
    through the app's one existing set of loaders -- so this function is
    pure formatting, not a second retrieval path."""
    nodes = network.get("nodes", []) or []
    edges = network.get("edges", []) or []
    node_index = {node.get("id"): node for node in nodes}

    primary_entity = _entity_brief(node_index[primary_entity_id]) if primary_entity_id in node_index else None
    key_entities = build_key_entities(primary_entity_id, nodes, edges, node_index)
    relationship_split = build_relationship_split(edges, node_index)
    network_summary = build_network_summary(nodes, edges, relationship_split)
    evidence_section = build_evidence_section(evidence_records or [])
    alerts_section = build_alerts_section(alerts_records or [])
    timeline_section = build_timeline_section(timeline_records or [])

    # AI-generated executive summary -- clearly labeled as such in the
    # response (`executive_summary.generated`/`.model`) so the frontend and
    # PDF export can never present it as anything other than AI output
    # grounded in the data above.
    ai_summary = graph_rag.generate_report_summary(
        case_id=case.get("id"),
        network=network,
        evidence_records=evidence_records or [],
        timeline_records=timeline_records or [],
        alerts_records=alerts_records or [],
        focus_entity_id=primary_entity_id,
    )

    limitations = build_limitations(
        primary_entity_id, evidence_records or [], timeline_records or [], relationship_split, ai_summary,
    )

    now = datetime.now(timezone.utc)
    return {
        "report_id": f"RPT-{case.get('id')}-{now.strftime('%Y%m%d%H%M%S')}",
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "generated_by": generated_by or "TraceX Investigator",
        "case": {
            "id": case.get("id"),
            "title": case.get("title"),
            "status": case.get("status"),
            "priority": case.get("priority"),
        },
        "primary_entity": primary_entity,
        "key_entities": key_entities,
        "connection_paths": connection_paths or [],
        "network_summary": network_summary,
        "relationships": relationship_split,
        "alerts": alerts_section,
        "evidence": evidence_section,
        "timeline": timeline_section,
        "executive_summary": ai_summary,
        "limitations": limitations,
    }
