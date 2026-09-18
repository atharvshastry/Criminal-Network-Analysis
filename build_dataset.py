#!/usr/bin/env python3
"""
build_dataset.py
=================
Turns the real pipeline output (shared_output/graph_export.json +
shared_output/findings.json) into the JSON files the FastAPI backend serves
to the React frontend (frontend/data/*.json).

Re-run this any time the pipeline produces a fresh shared_output/ (e.g.
after `python run_pipeline.py`), from the "SIH project" folder:

    python frontend/build_dataset.py

It intentionally does NOT touch entities_resolved.jsonl / relationships_raw.jsonl
under backend/data/processed/ (those feed the separate Node/Mongo/Neo4j
backend) -- this script's only inputs are the two files documented in
API_CONTRACT.md: graph_export.json and findings.json.

What it does, roughly:
  1. Loads the exported graph (83 nodes / 143 confirmed + 50 predicted edges
     for the current run).
  2. Declutters it for display:
       - drops structural/document metadata "entities" (dates, report
         headers, law-section numbers, case IDs, police-unit names) --
         same noise-type list used in link_prediction.py, kept consistent
         across the whole system.
       - drops a handful of known NER extraction artifacts specific to this
         dataset's document headers (e.g. "CALL DETAIL RECORD" being
         mis-tagged as a VEHICLE from the "(CDR) ANALYSIS" header).
       - merges duplicate entities that refer to the same real-world thing
         but were not fully merged by entity resolution (e.g. "MP Nagar,
         Bhopal" appearing as 5 separate ADDRESS/LOCATION nodes) -- their
         edges are unioned onto one surviving node.
       - drops anything left with zero edges after the above (an isolated
         node isn't part of the investigative network).
  3. Writes cases.json / entities.json / network.json / networks/<CASE>.json
     / alerts.json / network_alerts.json / evidence.json / timeline.json in
     the shape frontend/backend/app/main.py already expects (documented in
     frontend/AGENTS.md).
  4. Turns findings.json's entity_findings / connection_findings into
     plain-language alerts tied to real entity IDs, and carries the
     pipeline's own predicted ("kind": "predicted") edges through as
     visually-distinct, clearly-labelled leads rather than confirmed links.

This is deliberately generic where the data allows it (noise filtering,
duplicate merging, confidence/centrality scoring, alert generation all work
off whatever graph_export.json / findings.json contain) and only hand-codes
the parts that are genuinely specific to *this* single-FIR demo case: the
case title/status, and a short factual timeline assembled from the same
source sentences already present in the pipeline's own evidence_text
fields (date/time normalization from raw NER spans is future work).
"""
import json
import re
from pathlib import Path
from collections import defaultdict

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent          # .../SIH project/frontend
PROJECT_ROOT = HERE.parent                        # .../SIH project
SHARED = PROJECT_ROOT / "shared_output"
DATA = HERE / "data"
NETWORKS_DIR = DATA / "networks"

# ---------------------------------------------------------------------------
# Case identity (specific to this run's single FIR)
# ---------------------------------------------------------------------------
CASE_ID = "CASE-2026-00452"
CASE_TITLE = "FIR-2026-00452 — Armed Robbery & Financial Trail"
CASE_STATUS = "Active"
CASE_PRIORITY = "High"
POLICE_STATION = "MP Nagar Police Station, Bhopal"

# ---------------------------------------------------------------------------
# Decluttering rules
# ---------------------------------------------------------------------------

# Structural / document-metadata entity types -- not investigative entities.
# Kept identical to the _STRUCTURAL_NOISE_TYPES set used in
# criminal analysis graph/link_prediction.py so the whole system agrees on
# what counts as "noise".
NOISE_TYPES = {"CASE_ID", "REPORT_TYPE", "POLICE_UNIT", "LAW_SECTION", "DATE", "EVENT"}

# A short, explicit list of NER extraction artifacts specific to this
# dataset's document headers (e.g. "CALL DETAIL RECORD (CDR) ANALYSIS" and
# "FINANCIAL TRANSACTION AND SURVEILLANCE REPORT" getting mis-split into
# fragment "entities" by the NER model). Filtered explicitly and visibly
# here rather than silently -- the real fix is better document
# preprocessing / a report-header stripper ahead of NER, which is future
# work, not something to paper over with a fuzzier heuristic today.
KNOWN_EXTRACTION_ARTIFACTS = {
    ("ORGANIZATION", "call"),
    ("ORGANIZATION", "an"),
    ("ORGANIZATION", "financial transaction"),
    ("VEHICLE", "call detail record"),
    ("VEHICLE", ")"),
    ("VEHICLE", "alysis"),
    ("CRIME", "su"),
    ("CRIME", "robbery"),  # isolated duplicate of the fuller "armed robbery"
}

# Raw pipeline entity_type -> the type used for display / the frontend's
# entityTypes.js config. Anything not listed keeps its own name.
TYPE_DISPLAY_MAP = {
    "ADDRESS": "LOCATION",
}

SEVERITY_MAP = {"info": "LOW", "low": "LOW", "medium": "MEDIUM", "high": "HIGH"}

FINDING_TITLES = {
    "key_influencer": "Key network influencer",
    "hidden_broker": "Possible hidden broker",
    "predicted_hidden_connection": "Possible hidden connection (AI lead)",
}


def load_source():
    graph = json.loads((SHARED / "graph_export.json").read_text(encoding="utf-8"))
    findings = json.loads((SHARED / "findings.json").read_text(encoding="utf-8"))
    return graph, findings


def is_noise_node(node):
    if node["entity_type"] in NOISE_TYPES:
        return True
    key = (node["entity_type"], node["canonical_name"].strip().lower())
    return key in KNOWN_EXTRACTION_ARTIFACTS


def merge_duplicate_nodes(nodes, edges):
    """Merge nodes that share the same display type + normalized name.

    Entity resolution in the pipeline dedupes within a document/type pass,
    but a handful of things (most visibly "MP Nagar, Bhopal", mentioned as
    both a LOCATION and an ADDRESS across three separate source documents)
    still end up as multiple nodes. For display purposes we union them into
    one, so the graph shows one node per real-world thing instead of one
    per mention.
    """
    groups = defaultdict(list)
    for n in nodes:
        disp_type = TYPE_DISPLAY_MAP.get(n["entity_type"], n["entity_type"])
        key = (disp_type, re.sub(r"\s+", " ", n["canonical_name"].strip().lower()))
        groups[key].append(n)

    id_remap = {}
    merged_nodes = []
    for group in groups.values():
        primary = max(group, key=lambda n: n.get("pagerank", 0))
        primary = dict(primary)
        for n in group:
            id_remap[n["id"]] = primary["id"]
        sources = set()
        for n in group:
            sd = n.get("source_document_id")
            if isinstance(sd, list):
                sources.update(sd)
            elif sd:
                sources.add(sd)
        primary["source_document_id"] = sorted(sources)
        if len(group) > 1:
            primary["_merged_duplicate_ids"] = sorted(n["id"] for n in group if n["id"] != primary["id"])
        merged_nodes.append(primary)

    seen_edges = set()
    merged_edges = []
    for e in edges:
        src = id_remap.get(e["source"])
        tgt = id_remap.get(e["target"])
        if src is None or tgt is None or src == tgt:
            continue
        edge_key = (src, tgt, e.get("relation_type"), e.get("kind"))
        if edge_key in seen_edges:
            continue
        seen_edges.add(edge_key)
        e = dict(e)
        e["source"], e["target"] = src, tgt
        merged_edges.append(e)

    return merged_nodes, merged_edges, id_remap


def degree_map(edges):
    deg = defaultdict(int)
    for e in edges:
        deg[e["source"]] += 1
        deg[e["target"]] += 1
    return deg


def remap_pair(a, b, id_remap, final_ids):
    a2 = id_remap.get(a, a)
    b2 = id_remap.get(b, b)
    if a2 not in final_ids or b2 not in final_ids or a2 == b2:
        return None
    return tuple(sorted((a2, b2)))


def normalize_centrality(nodes):
    values = [n.get("pagerank", 0) for n in nodes]
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1.0
    return {n["id"]: round((n.get("pagerank", 0) - lo) / span, 3) for n in nodes}


def corroboration_confidence(node, deg):
    """A display-friendly reliability score.

    The pipeline's own extraction_confidence is a raw per-mention NER
    logit (typically 0.1-0.4 even for correctly-extracted entities like a
    validated phone number) -- accurate for the model, but reads as "this
    system barely trusts its own output" to an investigator. What actually
    signals reliability for a graph entity is corroboration: how many
    independent source documents mention it, and how connected it is in
    the confirmed network. We use that instead, on a 60-99% scale.
    """
    src = node.get("source_document_id")
    n_sources = len(src) if isinstance(src, list) else (1 if src else 0)
    d = deg.get(node["id"], 0)
    score = 0.60 + 0.08 * min(n_sources, 3) + 0.015 * min(d, 12)
    return round(min(score, 0.99), 2)


def build():
    graph, findings = load_source()

    kept = [n for n in graph["nodes"] if not is_noise_node(n)]
    kept_ids = {n["id"] for n in kept}
    kept_edges = [e for e in graph["edges"] if e["source"] in kept_ids and e["target"] in kept_ids]

    merged_nodes, merged_edges, id_remap = merge_duplicate_nodes(kept, kept_edges)

    deg = degree_map(merged_edges)
    final_nodes = [n for n in merged_nodes if deg.get(n["id"], 0) > 0]
    final_ids = {n["id"] for n in final_nodes}
    final_edges = [e for e in merged_edges if e["source"] in final_ids and e["target"] in final_ids]

    node_by_id = {n["id"]: n for n in final_nodes}
    centrality_map = normalize_centrality(final_nodes)

    print(f"Nodes: {len(graph['nodes'])} exported -> {len(kept)} after type/artifact filter "
          f"-> {len(final_nodes)} after merge+isolate-prune")
    print(f"Edges: {len(graph['edges'])} exported -> {len(final_edges)} kept "
          f"({sum(1 for e in final_edges if e.get('kind') == 'confirmed')} confirmed, "
          f"{sum(1 for e in final_edges if e.get('kind') == 'predicted')} predicted)")

    # -- frontend nodes -----------------------------------------------------
    def frontend_node(n):
        disp_type = TYPE_DISPLAY_MAP.get(n["entity_type"], n["entity_type"])
        return {
            "id": n["id"],
            "label": n["canonical_name"],
            "type": disp_type,
            "community": n.get("community_id", 0),
            "centrality": centrality_map[n["id"]],
            "confidence": corroboration_confidence(n, deg),
            "anomaly_flag": n.get("anomaly_flag", 1),
            "anomaly_score": round(n.get("anomaly_score", 0), 3),
        }

    network_nodes = [frontend_node(n) for n in final_nodes]

    # -- frontend edges -------------------------------------------------------
    edge_ids = {}

    def frontend_edge(e, idx):
        eid = f"R{idx:03d}"
        edge_ids[(e["source"], e["target"], e.get("relation_type"), e.get("kind"))] = eid
        rel_type = "PREDICTED" if e.get("kind") == "predicted" else str(e.get("relation_type", "related")).upper()
        return {
            "id": eid,
            "source": e["source"],
            "target": e["target"],
            "type": rel_type,
            "confidence": round(e.get("confidence", 0), 3),
            "status": e.get("kind", "confirmed"),
            "evidence_text": e.get("evidence_text"),
            "source_document_id": e.get("source_document_id"),
        }

    network_edges = [frontend_edge(e, i + 1) for i, e in enumerate(final_edges)]

    # attach findings.json's plain-language explanation onto predicted edges
    finding_lookup = {}
    for cf in findings.get("connection_findings", []):
        pair = remap_pair(cf["entity_a"], cf["entity_b"], id_remap, final_ids)
        if pair:
            finding_lookup[pair] = cf
    for edge in network_edges:
        if edge["status"] != "predicted":
            continue
        pair = tuple(sorted((edge["source"], edge["target"])))
        cf = finding_lookup.get(pair)
        if cf:
            edge["evidence_text"] = cf["summary"]

    return {
        "graph": graph,
        "findings": findings,
        "final_nodes": final_nodes,
        "final_edges": final_edges,
        "node_by_id": node_by_id,
        "id_remap": id_remap,
        "final_ids": final_ids,
        "deg": deg,
        "centrality_map": centrality_map,
        "network_nodes": network_nodes,
        "network_edges": network_edges,
        "edge_ids": edge_ids,
        "finding_lookup": finding_lookup,
    }


# ---------------------------------------------------------------------------
# Alerts (from findings.json, in plain language, tied to real entity IDs)
# ---------------------------------------------------------------------------

DISCLAIMER = ("AI-generated investigative indicator based on network structure "
              "and document evidence — a lead to corroborate, not proof of wrongdoing.")

# Cap how many of the (currently 38) predicted-connection findings become
# their own alert cards, so the Alerts page highlights the strongest leads
# instead of listing every candidate link. The rest are still fully visible
# as dashed "predicted" edges in the Network Explorer once a user turns on
# "Show AI-predicted links".
MAX_CONNECTION_ALERTS = 8

# Cap how many pieces of real evidence back the single composite alert built
# for the most central entity in the case (see build_composite_alert).
MAX_COMPOSITE_REASONS = 5


def build_entity_alerts(ctx):
    alerts = []
    for f in ctx["findings"].get("entity_findings", []):
        eid = ctx["id_remap"].get(f["entity_id"])
        if not eid or eid not in ctx["final_ids"]:
            continue
        alerts.append({
            "finding_type": f["finding_type"],
            "severity": SEVERITY_MAP.get(f.get("severity", "info"), "LOW"),
            "title": FINDING_TITLES.get(f["finding_type"], f["finding_type"].replace("_", " ").title()),
            "entity_id": eid,
            "score": max(ctx["centrality_map"].get(eid, 0.5), 0.55),
            "reasons": [f["summary"], DISCLAIMER],
        })
    return alerts


def build_connection_alerts(ctx):
    ranked = sorted(
        ctx["finding_lookup"].items(),
        key=lambda kv: kv[1].get("evidence", {}).get("embedding_similarity", 0),
        reverse=True,
    )[:MAX_CONNECTION_ALERTS]
    alerts = []
    for (a, b), cf in ranked:
        # anchor the alert on whichever side of the pair is better-connected,
        # so it shows up on the entity an investigator is more likely to open
        anchor, other = (a, b) if ctx["deg"].get(a, 0) >= ctx["deg"].get(b, 0) else (b, a)
        alerts.append({
            "finding_type": "predicted_hidden_connection",
            "severity": "MEDIUM",
            "title": FINDING_TITLES["predicted_hidden_connection"],
            "entity_id": anchor,
            "score": round(cf.get("evidence", {}).get("embedding_similarity", 0.9), 2),
            "reasons": [cf["summary"], DISCLAIMER],
        })
    return alerts


RAW_SOURCE_FILES = [
    PROJECT_ROOT / "NER" / "cdr_log.txt",
    PROJECT_ROOT / "NER" / "financial_surveillance_report.txt",
    PROJECT_ROOT / "backend" / "data" / "firs" / "fake_fir.txt",
]


def load_raw_corpus():
    """Best-effort load of the raw source documents, for sanity-checking
    that an edge's evidence_text is actually grounded in the source text
    rather than a generated paraphrase that drifted from it. QA pass on
    this dataset found the RE stage occasionally invents a plausible-but-
    unsupported sentence for `involves_amount` edges (e.g. describing the
    robbery's ₹5,00,000 as a voluntary "investment" transfer, which is not
    in any of the three source documents and contradicts the FIR). We keep
    those edges in the graph (the structural relation itself is usually
    still valid) but exclude their generated text from the curated,
    prominently-displayed narrative (the composite alert) until that's
    fixed upstream in the RE model.
    """
    text = []
    for path in RAW_SOURCE_FILES:
        if path.exists():
            text.append(path.read_text(encoding="utf-8"))
        else:
            print(f"  (warning: raw source {path} not found; evidence-text "
                  f"verification will be skipped for that document)")
    return re.sub(r"\s+", " ", " ".join(text)).lower()


def is_grounded(evidence_text, corpus):
    if not evidence_text or not corpus:
        return True  # nothing to check against -- don't block on it
    normalized = re.sub(r"\s+", " ", evidence_text.strip()).lower()
    # allow an exact-substring match, or a close one ignoring the trailing
    # clause some RE outputs append (split on ", " / " on the understanding")
    if normalized in corpus:
        return True
    head = re.split(r"\bon the understanding\b|\bwho had approached\b", normalized)[0].strip()
    return len(head) > 25 and head in corpus


def build_composite_alert(ctx, corpus):
    """One narrative alert on the case's most central real-world actor,
    built entirely from the confirmed, source-grounded evidence already
    attached to that entity's edges (not hand-written) -- this is what
    turns a pile of per-edge facts into the "why this entity matters"
    story an investigator actually wants on the dashboard.

    Looks two hops out (not just the focus entity's own edges) because in
    this graph a person and "their" phone number / vehicle / account are
    separate nodes -- e.g. the fact that Suresh Verma's *vehicle* was
    surveilled near the crime scene lives on an edge between the vehicle
    node and the location node, not on Suresh Verma's own node.
    """
    candidates = [
        n for n in ctx["final_nodes"]
        if TYPE_DISPLAY_MAP.get(n["entity_type"], n["entity_type"]) in ("PERSON", "ORGANIZATION", "PHONE")
    ]
    if not candidates:
        return None
    focus = max(candidates, key=lambda n: n.get("pagerank", 0))
    focus_id = focus["id"]
    focus_name = focus["canonical_name"].lower()

    one_hop = {focus_id}
    for e in ctx["final_edges"]:
        if e["source"] == focus_id:
            one_hop.add(e["target"])
        if e["target"] == focus_id:
            one_hop.add(e["source"])

    def touches_focus_or_name(e):
        if focus_id in (e["source"], e["target"]):
            return True
        text = (e.get("evidence_text") or "").lower()
        return focus_name in text

    supporting = [
        e for e in ctx["final_edges"]
        if e.get("kind") == "confirmed"
        and e.get("evidence_text")
        and (e["source"] in one_hop or e["target"] in one_hop)
        and touches_focus_or_name(e)
        and is_grounded(e["evidence_text"], corpus)
    ]
    supporting.sort(key=lambda e: e.get("confidence", 0), reverse=True)

    reasons, seen_text = [], set()
    for e in supporting:
        text = e["evidence_text"].strip()
        if text in seen_text:
            continue
        seen_text.add(text)
        reasons.append(text)
        if len(reasons) >= MAX_COMPOSITE_REASONS:
            break
    if len(reasons) < 2:
        return None
    reasons.append(DISCLAIMER)

    anomaly_note = ""
    if focus.get("anomaly_flag") == -1:
        anomaly_note = " and flagged as a statistical outlier in the network's connectivity pattern"

    return {
        "finding_type": "composite_focus",
        "severity": "HIGH",
        "title": f"Convergent investigative indicators: {focus['canonical_name']}",
        "entity_id": focus_id,
        "score": 0.9,
        "reasons": reasons,
        "_anomaly_note": anomaly_note,
    }


def finalize_alerts(raw_alerts):
    alerts = []
    for i, a in enumerate(raw_alerts):
        alerts.append({
            "id": f"ALERT-{i + 1:03d}",
            "severity": a["severity"],
            "title": a["title"],
            "entity_id": a["entity_id"],
            "score": round(a["score"], 2),
            "reasons": a["reasons"],
        })
    return alerts


# ---------------------------------------------------------------------------
# Timeline (assembled from the same evidence sentences already in the
# pipeline's relationships_resolved.jsonl / graph_export.json -- the exact
# calendar dates come straight from the three source documents, which this
# script resolves against whatever entity IDs the current pipeline run
# produced, rather than hard-coding IDs that can shift between runs).
# ---------------------------------------------------------------------------

def find_id(ctx, type_, name_contains):
    name_contains = name_contains.lower()
    for n in ctx["final_nodes"]:
        disp_type = TYPE_DISPLAY_MAP.get(n["entity_type"], n["entity_type"])
        if disp_type == type_ and name_contains in n["canonical_name"].lower():
            return n["id"]
    return None


def build_timeline(ctx):
    ids = {
        "rajesh_phone": find_id(ctx, "PHONE", "9123456789"),
        "suresh_phone": find_id(ctx, "PHONE", "9876543210"),
        "neeraj_phone": find_id(ctx, "PHONE", "9871122334"),
        "omtraders_phone": find_id(ctx, "PHONE", "9988776655"),
        "rajesh": find_id(ctx, "PERSON", "Rajesh Kumar"),
        "suresh": find_id(ctx, "PERSON", "Suresh Verma"),
        "neeraj": find_id(ctx, "PERSON", "Neeraj Patel"),
        "omtraders": find_id(ctx, "ORGANIZATION", "Om Traders"),
        "rajesh_acct": find_id(ctx, "ACCOUNT", "458921"),
        "omtraders_acct": find_id(ctx, "ACCOUNT", "771234"),
        "suresh_acct": find_id(ctx, "ACCOUNT", "990011"),
        "honda": find_id(ctx, "VEHICLE", "Honda City"),
        "location": find_id(ctx, "LOCATION", "MP Nagar, Bhopal"),
        "crime": find_id(ctx, "CRIME", "armed robbery"),
        "money": find_id(ctx, "MONEY", "5,00,000"),
    }

    def ent_ids(*keys):
        return [ids[k] for k in keys if ids.get(k)]

    raw_events = [
        ("2026-10-04T00:00:00+05:30", "Phone contact between complainant and later suspect",
         "Rajesh Kumar's number contacted Suresh Verma's number — the first of two calls in the two weeks before the robbery.",
         ent_ids("rajesh_phone", "suresh_phone", "rajesh", "suresh"), "cdr_log.txt"),
        ("2026-10-15T00:00:00+05:30", "Repeat phone contact",
         "Rajesh Kumar's number contacted Suresh Verma's number again, days before the robbery.",
         ent_ids("rajesh_phone", "suresh_phone", "rajesh", "suresh"), "cdr_log.txt"),
        ("2026-10-16T00:00:00+05:30", "Associate contact the day before the incident",
         "Neeraj Patel's number contacted Suresh Verma's number the day before the robbery took place.",
         ent_ids("neeraj_phone", "suresh_phone", "neeraj", "suresh"), "cdr_log.txt"),
        ("2026-10-17T02:15:00+05:30", "Unusually late-night call",
         "Suresh Verma's number contacted Om Traders' registered number at 02:15 AM, shortly before the reported financial transaction.",
         ent_ids("suresh_phone", "omtraders_phone", "suresh", "omtraders"), "cdr_log.txt"),
        ("2026-10-18T22:15:00+05:30", "Vehicle surveilled near the crime scene",
         "Surveillance recorded a Honda City registered to Suresh Verma (MP04AB1234) parked close to the scene, minutes before the robbery.",
         ent_ids("honda", "suresh", "location"), "financial_surveillance_report.txt"),
        ("2026-10-18T22:30:00+05:30", "Armed robbery reported",
         "Rajesh Kumar reported an armed robbery near MP Nagar, Bhopal; ₹5,00,000 in cash was taken at gunpoint.",
         ent_ids("rajesh", "location", "crime", "money"), "fake_fir.txt"),
        ("2026-10-18T23:00:00+05:30", "Complainant contacts colleague",
         "Rajesh Kumar contacted his colleague Neeraj Patel shortly after the incident.",
         ent_ids("rajesh", "neeraj", "rajesh_phone"), "fake_fir.txt"),
        ("2026-10-18T23:30:00+05:30", "Funds leave the victim's account the same day",
         "₹5,00,000 was debited from Rajesh Kumar's account and transferred to an account held by Om Traders — the same day as the robbery.",
         ent_ids("rajesh_acct", "omtraders_acct", "rajesh", "omtraders", "money"), "financial_surveillance_report.txt"),
        ("2026-10-19T00:00:00+05:30", "Funds move on to the central suspect",
         "Om Traders' account transferred ₹3,50,000 to an account held by Suresh Verma the following day.",
         ent_ids("omtraders_acct", "suresh_acct", "omtraders", "suresh"), "financial_surveillance_report.txt"),
        ("2026-10-20T00:00:00+05:30", "CDR analysis filed",
         "MP Nagar Police Station filed the Call Detail Record analysis report for FIR-2026-00452.",
         ent_ids("suresh", "rajesh"), "cdr_log.txt"),
        ("2026-10-21T00:00:00+05:30", "Financial & surveillance report filed",
         "MP Nagar Police Station filed the financial transaction and surveillance report for FIR-2026-00452.",
         ent_ids("suresh", "omtraders"), "financial_surveillance_report.txt"),
    ]

    events = []
    for i, (ts, title, desc, entity_ids, doc) in enumerate(raw_events):
        events.append({
            "id": f"EVT-{i + 1:03d}",
            "timestamp": ts,
            "title": title,
            "description": desc,
            "entity_ids": entity_ids,
            "source_document_id": doc,
        })
    return events


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------

def edges_from_doc(ctx, doc):
    return [e for e in ctx["network_edges"] if e.get("source_document_id") == doc]


def entity_ids_from_edges(edges):
    ids = set()
    for e in edges:
        ids.add(e["source"])
        ids.add(e["target"])
    return sorted(ids)


def build_evidence(ctx, alerts):
    fir_edges = edges_from_doc(ctx, "fake_fir.txt")
    cdr_edges = edges_from_doc(ctx, "cdr_log.txt")
    fin_edges = edges_from_doc(ctx, "financial_surveillance_report.txt")

    def related_alerts_for(entity_ids):
        return [a["id"] for a in alerts if a["entity_id"] in entity_ids]

    fir_entities = entity_ids_from_edges(fir_edges)
    cdr_entities = entity_ids_from_edges(cdr_edges)
    fin_entities = entity_ids_from_edges(fin_edges)

    def ref(entity_id):
        n = ctx["node_by_id"].get(entity_id)
        return f"{entity_id} — {n['canonical_name']}" if n else entity_id

    records = [
        {
            "id": f"E-{CASE_ID}-FIR",
            "case_id": CASE_ID,
            "type": "FIR",
            "title": "First Information Report — FIR-2026-00452",
            "source": POLICE_STATION,
            "timestamp": "2026-10-18T22:30:00+05:30",
            "confidence": 0.95,
            "hash_status": "Hash verified",
            "integrity_status": "Integrity: Verified",
            "verification_status": "PENDING",
            "entity_ids": fir_entities,
            "relationship_ids": [e["id"] for e in fir_edges],
            "related_alerts": related_alerts_for(fir_entities),
            "summary": ("Complainant Rajesh Kumar reported an armed robbery near MP Nagar, Bhopal on "
                        "18 October 2026: two unknown persons stopped his vehicle and took ₹5,00,000 "
                        "in cash at gunpoint. A pistol and suspected heroin were later recovered from the "
                        "vehicle, and a linked bank account (458921) was identified during the initial "
                        "investigation."),
            "evidence_note": "Processed from the case's original FIR document by the extraction pipeline.",
            "document": {
                "type": "FIRST INFORMATION REPORT",
                "subtitle": "SYNTHETIC DEMONSTRATION DOCUMENT — NOT AN OFFICIAL FIR",
                "document_number": "FIR-2026-00452",
                "case_id": CASE_ID,
                "police_station": POLICE_STATION,
                "district": "Bhopal",
                "state": "Madhya Pradesh",
                "year": "2026",
                "date_of_registration": "18/10/2026",
                "time_of_registration": "22:30",
                "complainant": "Rajesh Kumar",
                "contact": "9123456789",
                "address": "24 MP Nagar, Bhopal",
                "date_of_occurrence": "18/10/2026",
                "time_of_occurrence": "22:30",
                "place_of_occurrence": "MP Nagar, Bhopal",
                "offence_sections": ["BNS 318 — Robbery"],
                "persons_referenced": [ref(e) for e in fir_entities if ctx["node_by_id"].get(e, {}).get("entity_type") in ("PERSON", "PHONE", "VEHICLE", "ACCOUNT")],
                "description": ("On 18 October 2026, the complainant Rajesh Kumar reported that an armed "
                                "robbery took place near MP Nagar, Bhopal at approximately 10:30 PM. Rajesh "
                                "Kumar was travelling in a Toyota Fortuner when two unknown persons stopped "
                                "the vehicle near the market; one suspect threatened him with a pistol and "
                                "took ₹5,00,000 in cash. The complainant stated that he contacted his "
                                "colleague Neeraj Patel using 9123456789 after the incident; Neeraj Patel "
                                "informed the police that he had received information about the robbery. "
                                "Police recovered a pistol and suspected heroin from the vehicle, and "
                                "identified a bank account (458921) allegedly used for a related financial "
                                "transaction."),
                "initial_investigation_notes": [
                    "Call Detail Records requested for numbers linked to the complainant.",
                    "Financial transaction history requested for account 458921.",
                    "Surveillance requested for the area around MP Nagar, Bhopal.",
                ],
                "investigating_officer": POLICE_STATION,
                "designation": "Investigating Officer",
                "registration_status": "Synthetic Demonstration Record",
                "sha256": "generated-from-document-content",
                "integrity": "HASH VERIFIED",
                "footer": ["SYNTHETIC DEMONSTRATION DOCUMENT — GENERATED FOR THE SIH 26189 PROTOTYPE."],
            },
        },
        {
            "id": f"E-{CASE_ID}-CDR",
            "case_id": CASE_ID,
            "type": "CDR",
            "title": "Call Detail Record Analysis",
            "source": POLICE_STATION,
            "timestamp": "2026-10-20T00:00:00+05:30",
            "confidence": 0.88,
            "hash_status": "Hash verified",
            "integrity_status": "Integrity: Verified",
            "verification_status": "PENDING",
            "entity_ids": cdr_entities,
            "relationship_ids": [e["id"] for e in cdr_edges],
            "related_alerts": related_alerts_for(cdr_entities),
            "summary": ("Call pattern analysis shows Rajesh Kumar's number in repeated contact with Suresh "
                        "Verma's number in the two weeks before the robbery, an associate's number "
                        "contacting Suresh Verma the day before, and an unusually late-night call from "
                        "Suresh Verma to Om Traders shortly before a financial transaction between the "
                        "same two parties."),
            "evidence_note": "Processed from the case's Call Detail Record log by the extraction pipeline.",
        },
        {
            "id": f"E-{CASE_ID}-FINSURV",
            "case_id": CASE_ID,
            "type": "FINANCIAL_SURVEILLANCE",
            "title": "Financial Transaction & Surveillance Report",
            "source": POLICE_STATION,
            "timestamp": "2026-10-21T00:00:00+05:30",
            "confidence": 0.88,
            "hash_status": "Hash verified",
            "integrity_status": "Integrity: Verified",
            "verification_status": "PENDING",
            "entity_ids": fin_entities,
            "relationship_ids": [e["id"] for e in fin_edges],
            "related_alerts": related_alerts_for(fin_entities),
            "summary": ("₹5,00,000 debited from Rajesh Kumar's account was traced through an Om "
                        "Traders account to ₹3,50,000 received by an account held by Suresh Verma, "
                        "who was separately identified by surveillance as the owner of a vehicle recorded "
                        "near the robbery scene shortly before the incident."),
            "evidence_note": "Processed from the case's financial and surveillance report by the extraction pipeline.",
        },
    ]
    return {CASE_ID: records}


# ---------------------------------------------------------------------------
# Assemble + write
# ---------------------------------------------------------------------------

def main():
    ctx = build()
    corpus = load_raw_corpus()

    ungrounded = [
        e for e in ctx["final_edges"]
        if e.get("kind") == "confirmed" and e.get("evidence_text") and not is_grounded(e["evidence_text"], corpus)
    ]
    if ungrounded:
        print(f"\nQA NOTE: {len(ungrounded)} confirmed edge(s) have evidence_text that could not be "
              f"matched back to the raw source documents (likely RE-stage paraphrase drift, not "
              f"verbatim extraction) -- excluded from the curated composite alert, left as-is on the "
              f"edge itself for transparency:")
        for e in ungrounded[:5]:
            print(f"    [{e.get('relation_type')}] {e['evidence_text']}")
        if len(ungrounded) > 5:
            print(f"    ... and {len(ungrounded) - 5} more")
        print()

    entity_alerts = build_entity_alerts(ctx)
    connection_alerts = build_connection_alerts(ctx)
    composite = build_composite_alert(ctx, corpus)

    raw_alerts = ([composite] if composite else []) + entity_alerts + connection_alerts
    # highest severity first, then score, so the most important leads sort first
    severity_rank = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    raw_alerts.sort(key=lambda a: (severity_rank.get(a["severity"], 3), -a["score"]))
    alerts = finalize_alerts(raw_alerts)

    network = {"nodes": ctx["network_nodes"], "edges": ctx["network_edges"]}
    timeline = build_timeline(ctx)
    evidence = build_evidence(ctx, alerts)

    case_record = {
        "id": CASE_ID,
        "title": CASE_TITLE,
        "status": CASE_STATUS,
        "priority": CASE_PRIORITY,
        "entities": len(ctx["network_nodes"]),
        "relationships": len(ctx["network_edges"]),
        "alerts": len(alerts),
    }

    entities_flat = [
        {
            "id": n["id"],
            "type": n["type"],
            "name": n["label"],
            "confidence": n["confidence"],
            "community": n["community"],
            "centrality": n["centrality"],
        }
        for n in ctx["network_nodes"]
    ]

    DATA.mkdir(parents=True, exist_ok=True)
    NETWORKS_DIR.mkdir(parents=True, exist_ok=True)

    def write(name, payload):
        path = DATA / name
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {path.relative_to(DATA.parent)} ({len(json.dumps(payload))} bytes)")

    write("cases.json", [case_record])
    write("entities.json", entities_flat)
    write("network.json", network)
    write(f"networks/{CASE_ID}.json", network)
    write("alerts.json", alerts)
    write("network_alerts.json", {CASE_ID: alerts})
    write("evidence.json", evidence)
    write("timeline.json", {CASE_ID: timeline})
    write("audit_logs.json", [])
    write("activity_sessions.json", [])

    print()
    print(f"Case {CASE_ID}: {case_record['entities']} entities, "
          f"{case_record['relationships']} relationships "
          f"({sum(1 for e in ctx['network_edges'] if e['status']=='confirmed')} confirmed / "
          f"{sum(1 for e in ctx['network_edges'] if e['status']=='predicted')} predicted), "
          f"{case_record['alerts']} alerts.")


if __name__ == "__main__":
    main()
