"""
Rule-based document ingestion for user-uploaded case files.

This is deliberately NOT the heavy MuRIL NER / relation-extraction models that
live under the project's top-level NER/ and RE/ folders -- those need their
own multi-GB transformer weights, a separate virtual environment per stage,
and (for the full pipeline) a running Neo4j instance with GDS/APOC, so they
can only run as an offline batch job (see run_pipeline.py at the project
root). None of that fits inside a single HTTP request/response cycle.

Instead, this module does fast, synchronous, regex/heuristic entity and
relationship extraction over freshly uploaded documents (PDF/DOCX/TXT/CSV/
JSON), producing the same node/edge/evidence/timeline/alert shapes the rest
of the app already reads -- so a newly uploaded case is immediately
explorable through the existing Dashboard/Network Explorer/Evidence/Timeline
pages with zero extra plumbing. It's an honest "AI-assisted first pass",
not a claim of state-of-the-art extraction -- every alert/edge stays
traceable back to the literal sentence it came from.
"""
from __future__ import annotations

import csv
import io
import json
import re
from collections import defaultdict
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Text extraction per file format
# ---------------------------------------------------------------------------

class ExtractionError(Exception):
    pass


def extract_text(filename: str, raw: bytes, ext: str) -> str:
    ext = ext.lower()
    try:
        if ext == ".pdf":
            return _extract_pdf(raw)
        if ext == ".docx":
            return _extract_docx(raw)
        if ext == ".csv":
            return _extract_csv(raw)
        if ext == ".json":
            return _extract_json(raw)
        # .txt, .md and anything else we accept as plain text
        return _decode_text(raw)
    except ExtractionError:
        raise
    except Exception as exc:  # noqa: BLE001 - surface as a clean 400, not a 500
        raise ExtractionError(f"Could not read {filename}: {exc}") from exc


def _decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "latin-1"):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def _extract_pdf(raw: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if text.strip():
            pages.append(text)
    if not pages:
        raise ExtractionError("No extractable text found (the PDF may be scanned/image-only).")
    return "\n\n".join(pages)


def _extract_docx(raw: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(raw))
    parts = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        # A Word heading/title paragraph has no sentence-ending punctuation
        # of its own, which would otherwise let split_sentences' line-wrap
        # heuristic fold it straight into the next paragraph's sentence
        # (e.g. "Financial Statement Excerpt" + "Account number ... Vikram
        # Singh." merging into one "sentence" and dragging the heading text
        # into an unrelated entity/relationship match). Style is a reliable,
        # DOCX-specific signal for "this is a heading" that plain text/PDF
        # extraction doesn't have, so we use it here to terminate the line.
        style_name = (getattr(paragraph.style, "name", "") or "").lower()
        if style_name.startswith(("heading", "title")) and not re.search(r"[.!?।:]\s*$", text):
            text = f"{text}."
        parts.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _extract_csv(raw: bytes) -> str:
    text = _decode_text(raw)
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return ""
    header = rows[0]
    lines = []
    for row in rows[1:]:
        pairs = [f"{header[i].strip()}: {value.strip()}" for i, value in enumerate(row) if i < len(header) and value.strip()]
        if pairs:
            lines.append(". ".join(pairs) + ".")
    return "\n".join(lines) if lines else "\n".join(", ".join(row) for row in rows)


def _extract_json(raw: bytes) -> str:
    payload = json.loads(_decode_text(raw))

    def flatten(value, prefix=""):
        lines = []
        if isinstance(value, dict):
            for key, val in value.items():
                path = f"{prefix}.{key}" if prefix else str(key)
                lines.extend(flatten(val, path))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                lines.extend(flatten(item, f"{prefix}[{index}]"))
        else:
            if value not in (None, ""):
                label = prefix.rsplit(".", 1)[-1].replace("_", " ")
                lines.append(f"{label}: {value}.")
        return lines

    return "\n".join(flatten(payload))


# ---------------------------------------------------------------------------
# Sentence splitting (Unicode-aware, so Hindi/mixed-script text survives)
# ---------------------------------------------------------------------------

# Negative lookbehinds stop us from splitting mid-name/mid-amount on common
# abbreviations -- "Mr. Arjun Mehta" must stay one sentence (otherwise "Mr"
# strands as its own bogus entity), and "Rs. 5,00,000" must stay attached to
# its amount (otherwise MONEY_RE, which requires "Rs."/"₹"/"INR" immediately
# before the digits, never matches at all -- the currency prefix and the
# number end up in two different "sentences"). Each lookbehind must be
# fixed-width, hence one per abbreviation.
_TITLE_ABBREV_GUARD = (
    r"(?<!\bMr\.)(?<!\bMrs\.)(?<!\bMs\.)(?<!\bDr\.)(?<!\bSmt\.)(?<!\bM/s\.)(?<!\bNo\.)(?<!\bRs\.)"
)
# Splits after [.!?।] (guarded above) or at any newline that survives
# _join_wrapped_lines below -- by the time this runs, a lone newline left in
# the text is a genuine line/sentence break, not a mid-sentence PDF wrap.
_SENTENCE_SPLIT_RE = re.compile(_TITLE_ABBREV_GUARD + r"(?:(?<=[.!?।])\s+|\n+)")


def _join_wrapped_lines(text: str) -> str:
    """Collapse a PDF/DOCX hard line-wrap back into the sentence it
    interrupted, so the entity/relationship regexes see one whole sentence
    instead of two fragments. Heuristic: if the previous line ends with no
    terminal punctuation and isn't an all-caps heading, the break is almost
    always a mid-sentence wrap rather than a real new sentence -- this holds
    whether the continuation starts lowercase ("...the vehicle\nwas found")
    or with a capitalized word/abbreviation ("...Vertex Traders\nPvt Ltd"),
    so we don't gate on the next line's case. Structured one-fact-per-line
    output (our own CSV/JSON flattening, most report text) already ends
    each line with a period, so those lines are correctly left un-joined.

    A line containing a colon ANYWHERE (not just at the end) is also left
    un-joined: this is almost always a self-contained "Label: value" fact
    from a structured report ("Witness 1: Priya Sharma", "Place: Bhopal")
    rather than a wrapped sentence, and merging the next label/heading line
    onto it is how unrelated section headings/labels used to get glued
    together into a single bogus name-shaped phrase (e.g. "Witness 1: Priya
    Sharma" + "Witness 2: Mohit Jain" collapsing into one blob that reads,
    to the name-matching regexes, as "...Priya Sharma Witness..." spanning
    two different people's fields)."""
    joined = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if (
            joined
            and not joined[-1].isupper()
            and not re.search(r"[.!?।:]\s*$", joined[-1])
            and ":" not in joined[-1]
        ):
            joined[-1] = f"{joined[-1]} {line}"
        else:
            joined.append(line)
    return "\n".join(joined)


def split_sentences(text: str):
    text = re.sub(r"[ \t]+", " ", text)
    text = _join_wrapped_lines(text)
    chunks = [chunk.strip() for chunk in _SENTENCE_SPLIT_RE.split(text) if chunk.strip()]
    # Very long "sentences" (e.g. a CSV row or an unpunctuated block) still get
    # extraction run over them, but we cap length so one pathological line
    # can't blow up regex/co-occurrence cost.
    return [chunk[:1200] for chunk in chunks]


# ---------------------------------------------------------------------------
# Entity extraction: regex + keyword heuristics
# ---------------------------------------------------------------------------

INDIAN_PHONE_RE = re.compile(r"(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)")
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
SOCIAL_ID_RE = re.compile(r"(?<!\w)@[a-zA-Z0-9_.]{3,30}")
VEHICLE_RE = re.compile(r"\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{3,4}\b")
MONEY_RE = re.compile(
    r"(?:₹|Rs\.?|INR)\s?[\d,]+(?:\.\d+)?(?:\s?(?:lakh|lac|crore))?"
    r"|\b[\d,]+(?:\.\d+)?\s?(?:lakh|lac|crore)\b",
    re.IGNORECASE,
)
ACCOUNT_CONTEXT_RE = re.compile(
    r"(?:account(?:\s+(?:no\.?|number))?|a/c(?:\s+no\.?)?)\s*[:\-]?\s*(\d{6,18})",
    re.IGNORECASE,
)
DATE_RE = re.compile(
    r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"
    r"|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b",
    re.IGNORECASE,
)

PERSON_TITLE_RE = re.compile(
    r"(?:Mr\.?|Mrs\.?|Ms\.?|Shri|Smt\.?|Dr\.?)\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,2})"
)
# NOTE: the keyword alternation is matched case-insensitively via the scoped
# (?i:...) group, but the capture group itself is deliberately NOT covered by
# that flag -- it must still require an actual capital letter, otherwise it
# greedily swallows ordinary lowercase words ("of", "stated that he", "name")
# as if they were person names.
PERSON_CONTEXT_RE = re.compile(
    r"(?:(?i:complainant|accused|victim|witness|suspect|informant|director|signatory|"
    r"authorised signatory|proprietor|owner|resident))"
    r"[,:\s]+(?:(?i:is|was|named)\s+)?([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,2})"
)
GENERIC_NAME_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b")

ORG_SUFFIX_RE = re.compile(
    # NOTE: each word before the suffix keyword must itself start with a
    # capital letter (word-by-word, like ORG_PREFIX_RE below) rather than a
    # raw "any letters/spaces up to 60 chars" span. A character-count bound
    # alone is not enough: since re.search takes the LEFTMOST match (not the
    # shortest), a free-form span happily walks back across ordinary
    # lowercase sentence words ("...was found at the Vertex Traders") to
    # reach an earlier capital letter, swallowing most of the sentence into
    # a bogus "organization" name. Requiring each word to be capitalized
    # stops at the first lowercase filler word instead.
    r"\b([A-Z][A-Za-z&.]*(?:\s[A-Z][A-Za-z&.]*){0,4}\s"
    r"(?:Pvt\.?\s?Ltd\.?|Ltd\.?|LLP|Inc\.?|Corp\.?|Bank|Company|Enterprises|Fintech|Traders|Industries))\b"
)
# Word-by-word (each word must itself start with a capital letter) rather
# than a greedy catch-all character class, so this stops at the first
# lowercase connector word ("an", "which", ...) instead of swallowing the
# rest of the sentence into one garbled label.
ORG_PREFIX_RE = re.compile(r"\bM/s\.?\s+([A-Z][A-Za-z&.]*(?:\s+[A-Z][A-Za-z&.]*){0,5})")

LOCATION_KEYWORDS = {
    "bengaluru", "bangalore", "mumbai", "delhi", "new delhi", "chennai", "kolkata", "hyderabad",
    "pune", "ahmedabad", "jaipur", "lucknow", "kanpur", "nagpur", "indore", "bhopal", "patna",
    "surat", "vadodara", "coimbatore", "kochi", "chandigarh", "goa", "noida", "gurugram", "gurgaon",
    "karnataka", "maharashtra", "tamil nadu", "kerala", "telangana", "uttar pradesh", "west bengal",
    "rajasthan", "gujarat", "punjab", "haryana", "bihar", "odisha", "assam",
    "koramangala", "whitefield", "andheri", "dwarka", "saket", "hitech city",
}
LOCATION_SUFFIX_RE = re.compile(
    r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s?(?:Nagar|Colony|Road|Street|Sector\s?\d+|District|Marg|Chowk))\b"
)
LOCATION_CONTEXT_RE = re.compile(
    r"(?:resident of|residing at|address(?:\s+is)?|located at|at|in)\s+"
    r"([A-Z][a-zA-Z]+(?:\s?\d+)?(?:,?\s+[A-Z][a-zA-Z]+(?:\s?\d+)?){0,3})"
)

WEAPON_KEYWORDS = {
    "pistol", "revolver", "rifle", "handgun", "gun", "firearm", "knife", "dagger", "sword",
    "country-made pistol", "assault rifle", "grenade", "explosive",
}
DRUG_KEYWORDS = {
    "heroin", "cocaine", "ganja", "cannabis", "marijuana", "mdma", "brown sugar", "opium",
    "narcotics", "charas", "hashish", "methamphetamine", "smack", "poppy husk",
}
CRIME_KEYWORDS = {
    "fraud", "robbery", "theft", "trafficking", "assault", "murder", "kidnapping", "extortion",
    "cheating", "forgery", "smuggling", "narcotics trafficking", "money laundering", "laundering",
    "phishing", "cybercrime", "burglary", "abduction", "harassment", "counterfeiting",
}

STRUCTURED_PERSON_LABEL_RE = re.compile(
    r"(?im)^(?:name|complainant|accused|victim|witness|director|officer|informant)\s*\d{0,2}\s*[:\-]\s*(.+)$"
)


def _clean_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip(" .,:;")


def _looks_like_place_or_org(name: str) -> bool:
    lowered = name.lower()
    return lowered in LOCATION_KEYWORDS or bool(ORG_SUFFIX_RE.search(name))


COMMON_FALSE_POSITIVE_PHRASES = {
    "the complainant", "the accused", "the victim", "the witness", "the suspect",
    "police station", "first information", "call detail", "bank account",
}

# Report/document scaffolding words -- section headings like "Financial
# Transaction Indicators", "Referenced Items" or "Investigating Officer
# Notes" are themselves title-case, multi-word phrases, so they otherwise
# look exactly like a person's name to GENERIC_NAME_RE/PERSON_CONTEXT_RE. If
# ANY word of a candidate name is one of these generic report/structure
# nouns, it's read as document scaffolding rather than a name mention.
HEADING_NOISE_WORDS = {
    "summary", "indicator", "indicators", "information", "map", "item", "items",
    "note", "notes", "classification", "document", "documents", "report", "reports",
    "overview", "details", "detail", "analysis", "relationship", "relationships",
    "preliminary", "referenced", "reference", "investigating", "investigation",
    "officer", "officers", "mentioned", "entities", "entity", "type", "types",
    "zone", "section", "sections", "excerpt", "statement", "record", "records",
    "description", "descriptions", "narrative", "chronology", "annexure",
    "appendix", "legend", "index", "contents", "station", "police",
    # Common vehicle make/model words: "Toyota Fortuner" or "Royal Enfield"
    # sitting next to a registration number is a vehicle, not a person, even
    # though it's shaped exactly like a two-word proper name.
    "toyota", "honda", "maruti", "suzuki", "hyundai", "tata", "mahindra", "ford",
    "hero", "bajaj", "kia", "renault", "volkswagen", "skoda", "nissan", "royal",
    "enfield", "fortuner", "innova", "swift", "activa", "splendor", "pulsar",
    "scorpio", "thar", "creta", "verna", "baleno", "alto", "duster", "nexon",
    "harrier", "safari", "ertiga",
}


def _is_heading_like(candidate: str) -> bool:
    """True when a title-case candidate reads as a document heading/label
    ("Financial Transaction Indicators", "Referenced Items") rather than a
    person's name -- either because one of its words is generic report
    scaffolding, or because every one of its words is fully upper-case (a
    legend/acronym line such as "PERSON, ORG, LOC, PHONE")."""
    words = [w.strip(",.:;()") for w in candidate.split() if w.strip(",.:;()")]
    if not words:
        return False
    if len(words) >= 2 and all(w.isupper() for w in words):
        return True
    return any(w.lower() in HEADING_NOISE_WORDS for w in words)


def _followed_by_label_colon(sentence: str, match_end: int) -> bool:
    """True when the text right after a matched candidate starts with a
    colon/dash ("Document Type: FIR", "Suspect Vehicle: MP04 AB 7821") --
    that shape means the candidate is a field LABEL, not a name being
    mentioned in prose. This is common in structured report text where a
    label line without its own punctuation gets joined to the next line."""
    rest = sentence[match_end:].lstrip()
    return rest[:1] in (":", "-", "–", "—")


def extract_entities_from_sentence(sentence: str):
    """Returns a list of {type, text, norm} entity mentions found in one sentence."""
    found = []

    def add(entity_type, text):
        cleaned = _clean_name(text)
        if len(cleaned) < 2:
            return
        # A "Rs" or "INR" match with no digits attached to it isn't a real
        # amount (can happen if a currency prefix gets separated from its
        # number by an upstream line-join edge case) -- don't file it as a
        # MONEY entity with no actual figure.
        if entity_type == "MONEY" and not any(ch.isdigit() for ch in cleaned):
            return
        # Applies to every named-entity type, not just PERSON: a structured
        # report's own section headings/labels and legend lines ("PERSON,
        # ORG, LOC, PHONE") are title-case or all-caps multi-word phrases
        # too, and would otherwise be indistinguishable from a real
        # person/organization/location name.
        if entity_type in ("PERSON", "ORGANIZATION", "LOCATION") and _is_heading_like(cleaned):
            return
        found.append({"type": entity_type, "text": cleaned, "norm": _normalize_key(entity_type, cleaned)})

    for match in INDIAN_PHONE_RE.finditer(sentence):
        add("PHONE", match.group())
    for match in EMAIL_RE.finditer(sentence):
        add("EMAIL", match.group())
    for match in SOCIAL_ID_RE.finditer(sentence):
        add("SOCIAL_ID", match.group())
    for match in VEHICLE_RE.finditer(sentence):
        add("VEHICLE", match.group())
    for match in ACCOUNT_CONTEXT_RE.finditer(sentence):
        add("ACCOUNT", match.group(1))
    for match in MONEY_RE.finditer(sentence):
        add("MONEY", match.group())
    for match in ORG_SUFFIX_RE.finditer(sentence):
        add("ORGANIZATION", match.group(1))
    for match in ORG_PREFIX_RE.finditer(sentence):
        add("ORGANIZATION", match.group(1))
    for match in LOCATION_CONTEXT_RE.finditer(sentence):
        candidate = match.group(1)
        if not _looks_like_place_or_org(candidate):
            add("LOCATION", candidate)
    for match in LOCATION_SUFFIX_RE.finditer(sentence):
        add("LOCATION", match.group(1))
    lowered = sentence.lower()
    for keyword in LOCATION_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", lowered):
            add("LOCATION", keyword.title())
    for keyword in WEAPON_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", lowered):
            add("WEAPON", keyword.title())
    for keyword in DRUG_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", lowered):
            add("DRUG", keyword.title())
    for keyword in CRIME_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", lowered):
            add("CRIME", keyword.title())

    org_spans = {m.group(1) for m in ORG_SUFFIX_RE.finditer(sentence)} | {m.group(1) for m in ORG_PREFIX_RE.finditer(sentence)}
    # Text already claimed as a LOCATION (by the suffix or context patterns
    # above) shouldn't also be filed as a PERSON -- e.g. "Hoshangabad Road"
    # is a place, not a name, even though it's a valid GENERIC_NAME_RE shape.
    location_spans = (
        {m.group(1) for m in LOCATION_SUFFIX_RE.finditer(sentence)}
        | {m.group(1) for m in LOCATION_CONTEXT_RE.finditer(sentence)}
    )

    for match in STRUCTURED_PERSON_LABEL_RE.finditer(sentence):
        candidate = match.group(1).split(",")[0].split("(")[0]
        if re.match(r"^[A-Za-z .]{2,60}$", candidate.strip()):
            add("PERSON", candidate)
    for match in PERSON_TITLE_RE.finditer(sentence):
        add("PERSON", match.group(1))
    for match in PERSON_CONTEXT_RE.finditer(sentence):
        candidate = match.group(1)
        if candidate not in org_spans:
            add("PERSON", candidate)
    for match in GENERIC_NAME_RE.finditer(sentence):
        candidate = match.group(1)
        if candidate in org_spans or candidate in location_spans or candidate.lower() in COMMON_FALSE_POSITIVE_PHRASES:
            continue
        if _looks_like_place_or_org(candidate):
            continue
        # A title-case phrase that IS the entire line, with nothing else
        # (no verb, no punctuation, no surrounding context) reads as a
        # document heading ("Financial Statement Excerpt") rather than a
        # person being mentioned -- a real name mention almost always sits
        # inside a sentence with some context around it.
        if candidate == sentence.strip().rstrip(".!?।: "):
            continue
        # "Document Type: FIR", "Suspect Vehicle: MP04 AB 7821" -- the
        # candidate sits immediately before a colon/dash, so it's a field
        # LABEL (from a structured report line), not a name in prose.
        if _followed_by_label_colon(sentence, match.end()):
            continue
        add("PERSON", candidate)

    # De-duplicate mentions of the same (type, norm) within one sentence.
    unique = {}
    for item in found:
        unique[(item["type"], item["norm"])] = item
    return list(unique.values())


def _normalize_key(entity_type: str, text: str) -> str:
    if entity_type == "PHONE":
        return re.sub(r"\D", "", text)[-10:]
    if entity_type in ("EMAIL", "SOCIAL_ID"):
        return text.lower()
    return re.sub(r"\s+", " ", text).strip().lower()


# ---------------------------------------------------------------------------
# Relationship heuristics (per-sentence, so every edge stays traceable to
# the literal sentence it was derived from)
# ---------------------------------------------------------------------------

RELATION_PATTERNS = [
    # (regex over the sentence, source type, target type, relation type, directional)
    (re.compile(r"registered to|belongs to|owned by|held by|owns|holds", re.IGNORECASE), "PHONE", "PERSON", "OWNS", False),
    (re.compile(r"registered to|belongs to|owned by|held by|owns|holds|in the name of", re.IGNORECASE), "ACCOUNT", "PERSON", "OWNS", False),
    (re.compile(r"registered to|belongs to|owned by|held by|owns|holds", re.IGNORECASE), "VEHICLE", "PERSON", "OWNS", False),
    (re.compile(r"resident of|residing at|resides at|address", re.IGNORECASE), "PERSON", "LOCATION", "RESIDES_AT", True),
    (re.compile(r"director|signatory|authorised signatory|works? at|employee of|owner of|proprietor of|affiliated", re.IGNORECASE), "PERSON", "ORGANIZATION", "AFFILIATED_WITH", True),
    (re.compile(r"contact(?:ed)?|call(?:ed)?|spoke to|spoke with|phone(?:d)?", re.IGNORECASE), "PERSON", "PHONE", "CONTACT_NUMBER", True),
    (re.compile(r"email(?:ed)?|e-mail", re.IGNORECASE), "PERSON", "EMAIL", "CONTACT_EMAIL", True),
    (re.compile(r"debited|credited|transferred|routed|deposited|withdrawn|paid", re.IGNORECASE), "ACCOUNT", "ACCOUNT", "TRANSFERRED_TO", True),
    (re.compile(r"debited|credited|transferred|amount of|worth|paid|received", re.IGNORECASE), "ACCOUNT", "MONEY", "INVOLVES_AMOUNT", True),
    (re.compile(r"debited|credited|transferred|amount of|worth|paid|received", re.IGNORECASE), "PERSON", "MONEY", "INVOLVES_AMOUNT", True),
    (re.compile(r"accused|charged with|suspected of|perpetrat", re.IGNORECASE), "PERSON", "CRIME", "ACCUSED_OF", True),
    (re.compile(r"victim of|complainant|defrauded|targeted", re.IGNORECASE), "PERSON", "CRIME", "VICTIM_OF", True),
    (re.compile(r"used|carried|armed with|wielding", re.IGNORECASE), "PERSON", "WEAPON", "USED_WEAPON", True),
    (re.compile(r"possess|found with|seized|recovered", re.IGNORECASE), "PERSON", "DRUG", "POSSESSES_DRUG", True),
    (re.compile(r"identified by|linked to handle|handle", re.IGNORECASE), "PERSON", "SOCIAL_ID", "IDENTIFIED_BY", True),
    (re.compile(r"occurred at|took place at|happened at|incident at", re.IGNORECASE), "CRIME", "LOCATION", "OCCURRED_AT", True),
]

# A confident pattern hit gets this score; the co-occurrence fallback gets a lower one.
PATTERN_CONFIDENCE = 0.82
COOCCURRENCE_CONFIDENCE = 0.45

# A "sentence" that mentions many different entities (common when a
# structured report's field lines get merged together, or a table row is
# flattened into one line) would otherwise produce a full pairwise "everyone
# mentioned with everyone" clique from the fallback below -- a single
# sentence mentioning N entities yields C(N,2) edges, which floods the graph
# with low-confidence noise and makes it unreadable. Past this many
# mentions in one sentence, only chain each mention to its next couple of
# neighbors (still enough to keep every entity traceable back to the
# sentence via *some* edge) instead of the full O(n^2) pairing.
MAX_MENTIONS_FOR_FULL_COOCCURRENCE = 6
COOCCURRENCE_CHAIN_WINDOW = 2


def infer_relationships(sentence: str, mentions: list):
    """Given the entity mentions found in one sentence, propose relationships
    between them: a specific pattern match where the sentence's wording
    matches a known relation phrase, else a lower-confidence generic
    co-occurrence edge between every pair of distinct entities."""
    if len(mentions) < 2:
        return []

    edges = []
    by_type = defaultdict(list)
    for mention in mentions:
        by_type[mention["type"]].append(mention)

    matched_pairs = set()
    for pattern, source_type, target_type, relation_type, directional in RELATION_PATTERNS:
        if not pattern.search(sentence):
            continue
        sources = by_type.get(source_type, [])
        targets = by_type.get(target_type, [])
        for source in sources:
            for target in targets:
                if source["norm"] == target["norm"] and source["type"] == target["type"]:
                    continue
                pair_key = tuple(sorted([f"{source['type']}:{source['norm']}", f"{target['type']}:{target['norm']}"]))
                if pair_key in matched_pairs:
                    continue
                matched_pairs.add(pair_key)
                edges.append({
                    "source": source, "target": target,
                    "type": relation_type, "confidence": PATTERN_CONFIDENCE,
                })

    # Fallback: any two *different* entities mentioned in the same sentence
    # that didn't already get a specific relation are still worth showing as
    # connected, just with lower confidence and a generic label -- unless
    # this sentence mentions so many entities that full pairwise coverage
    # would itself become the noise (see MAX_MENTIONS_FOR_FULL_COOCCURRENCE).
    dense_sentence = len(mentions) > MAX_MENTIONS_FOR_FULL_COOCCURRENCE
    for i in range(len(mentions)):
        j_upper = min(i + 1 + COOCCURRENCE_CHAIN_WINDOW, len(mentions)) if dense_sentence else len(mentions)
        for j in range(i + 1, j_upper):
            a, b = mentions[i], mentions[j]
            if a["norm"] == b["norm"] and a["type"] == b["type"]:
                continue
            pair_key = tuple(sorted([f"{a['type']}:{a['norm']}", f"{b['type']}:{b['norm']}"]))
            if pair_key in matched_pairs:
                continue
            matched_pairs.add(pair_key)
            edges.append({
                "source": a, "target": b,
                "type": "MENTIONED_WITH", "confidence": COOCCURRENCE_CONFIDENCE,
            })

    return edges


# ---------------------------------------------------------------------------
# Orchestration: documents -> case network + evidence + timeline + alerts
# ---------------------------------------------------------------------------

FILE_TYPE_LABELS = {
    ".pdf": "PDF REPORT", ".docx": "WORD DOCUMENT", ".txt": "TEXT REPORT",
    ".csv": "CSV RECORDS", ".json": "JSON RECORDS", ".md": "TEXT REPORT",
}

MIN_MENTIONS_TO_KEEP = 1  # every extracted entity is kept; alerts rank by degree instead

# A lightweight stand-in for the offline pipeline's Node2Vec + shared-neighbor
# link prediction (see link_prediction.py in the full pipeline, which needs
# trained embeddings and can only run as a batch job). Two entities that are
# NOT already directly connected, but that share several common connections,
# get surfaced as a candidate lead -- clearly marked as AI-predicted and never
# presented as a confirmed fact, matching how the real pipeline's predicted
# edges are labeled (status: "predicted", type: "PREDICTED").
MIN_SHARED_NEIGHBORS_FOR_PREDICTION = 2
MAX_PREDICTED_LINKS = 6
MAX_NODES_FOR_PREDICTION = 800  # guard against O(n^2) pair-scanning on huge graphs


def _predicted_links(nodes_by_key, adjacency, case_id, counter):
    node_ids = [node["id"] for node in nodes_by_key.values()]
    if len(node_ids) > MAX_NODES_FOR_PREDICTION:
        return []
    id_to_key = {node["id"]: key for key, node in nodes_by_key.items()}

    candidates = []
    for i in range(len(node_ids)):
        source_id = node_ids[i]
        neighbors_a = adjacency.get(source_id)
        if not neighbors_a:
            continue
        for j in range(i + 1, len(node_ids)):
            target_id = node_ids[j]
            if target_id in neighbors_a:
                continue  # already directly (confirmed) connected -- not a "prediction"
            neighbors_b = adjacency.get(target_id)
            if not neighbors_b:
                continue
            shared = neighbors_a & neighbors_b
            if len(shared) < MIN_SHARED_NEIGHBORS_FOR_PREDICTION:
                continue
            union = neighbors_a | neighbors_b
            similarity = len(shared) / len(union) if union else 0.0
            candidates.append((source_id, target_id, len(shared), similarity))

    candidates.sort(key=lambda item: (item[2], item[3]), reverse=True)

    predicted_edges = []
    for source_id, target_id, shared_count, similarity in candidates[:MAX_PREDICTED_LINKS]:
        source_node = nodes_by_key[id_to_key[source_id]]
        target_node = nodes_by_key[id_to_key[target_id]]
        score = round(min(0.97, 0.55 + 0.08 * shared_count + 0.2 * similarity), 2)
        counter["edge"] += 1
        predicted_edges.append({
            "id": f"PRED_{case_id[-5:] if len(case_id) >= 5 else case_id}_{counter['edge']:03d}",
            "source": source_id,
            "target": target_id,
            "type": "PREDICTED",
            "confidence": score,
            "status": "predicted",
            "evidence_text": (
                f"{source_node['label']} and {target_node['label']} are not directly linked in the data, "
                f"but share {shared_count} common connection(s) and a high structural similarity score "
                f"({score}) — a candidate lead worth investigating, not a confirmed connection."
            ),
            "source_document_id": None,
        })
    return predicted_edges


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_case_from_documents(case_id: str, documents: list, id_prefix: str = "ent"):
    """
    documents: list of {"filename": str, "ext": str, "text": str, "sha256": str, "size": int}
    Returns {"nodes", "edges", "evidence", "timeline", "alerts"} in the exact
    shape the rest of the backend already reads/writes.
    """
    nodes_by_key = {}           # (type, norm) -> node dict
    node_doc_ids = defaultdict(set)   # (type, norm) -> set(filename)
    node_mention_count = defaultdict(int)
    edges_by_key = {}            # (min_id,max_id,type) -> edge dict
    evidence_records = []
    timeline_events = []

    counter = {"node": 0, "edge": 0, "event": 0}

    def node_id_for(entity_type, norm):
        key = (entity_type, norm)
        if key not in nodes_by_key:
            counter["node"] += 1
            nodes_by_key[key] = {
                "id": f"{id_prefix}_{case_id[-5:] if len(case_id) >= 5 else case_id}_{counter['node']:03d}",
                "label": None,
                "type": entity_type,
                "community": 0,
                "centrality": 0.0,
                "confidence": 0.0,
                "anomaly_flag": 0,
                "anomaly_score": 0.0,
            }
        return nodes_by_key[key]["id"]

    id_lookup = {}

    for doc in documents:
        filename = doc["filename"]
        text = doc["text"]
        sentences = split_sentences(text)
        doc_entity_ids = set()
        doc_edge_ids = set()
        first_sentence_with_entities = None

        for sentence in sentences:
            mentions = extract_entities_from_sentence(sentence)
            if not mentions:
                continue
            if first_sentence_with_entities is None:
                first_sentence_with_entities = sentence

            resolved = []
            for mention in mentions:
                node = nodes_by_key.get((mention["type"], mention["norm"]))
                node_id = node_id_for(mention["type"], mention["norm"])
                node = nodes_by_key[(mention["type"], mention["norm"])]
                if node["label"] is None or len(mention["text"]) > len(node["label"]):
                    node["label"] = mention["text"]
                node_doc_ids[(mention["type"], mention["norm"])].add(filename)
                node_mention_count[(mention["type"], mention["norm"])] += 1
                id_lookup[node_id] = (mention["type"], mention["norm"])
                doc_entity_ids.add(node_id)
                resolved.append({**mention, "id": node_id})

            for rel in infer_relationships(sentence, mentions):
                source_id = node_id_for(rel["source"]["type"], rel["source"]["norm"])
                target_id = node_id_for(rel["target"]["type"], rel["target"]["norm"])
                if source_id == target_id:
                    continue
                edge_key = tuple(sorted([source_id, target_id]) + [rel["type"]])
                existing = edges_by_key.get(edge_key)
                if existing and existing["confidence"] >= rel["confidence"]:
                    continue
                counter["edge"] += 1
                edge_id = existing["id"] if existing else f"REL_{case_id[-5:] if len(case_id) >= 5 else case_id}_{counter['edge']:03d}"
                edges_by_key[edge_key] = {
                    "id": edge_id,
                    "source": source_id,
                    "target": target_id,
                    "type": rel["type"],
                    "confidence": rel["confidence"],
                    "status": "confirmed",
                    "evidence_text": sentence[:500],
                    "source_document_id": filename,
                }
                doc_edge_ids.add(edge_id)

        # One evidence record per uploaded document, using the exact schema
        # the frontend's Evidence page already renders (generic fallback path).
        ext = doc.get("ext", "")
        excerpt = text.strip()
        evidence_records.append({
            "id": f"EVID-{case_id}-{len(evidence_records) + 1:03d}",
            "case_id": case_id,
            "type": FILE_TYPE_LABELS.get(ext, "DOCUMENT"),
            "title": filename,
            "source": "Uploaded document",
            "timestamp": _now_iso(),
            "confidence": 1.0,
            "hash_status": "Hash verified",
            "integrity_status": "Integrity: Verified",
            "verification_status": "PENDING",
            "entity_ids": sorted(doc_entity_ids),
            "relationship_ids": sorted(doc_edge_ids),
            "related_alerts": [],
            "summary": (excerpt[:400] + "…") if len(excerpt) > 400 else excerpt or "No extractable text found in this document.",
            "evidence_note": excerpt[:20000],
        })

        counter["event"] += 1
        timeline_events.append({
            "id": f"EVT-{case_id}-{counter['event']:03d}",
            "timestamp": _now_iso(),
            "title": f"{filename} ingested and analyzed",
            "description": (
                f"{len(doc_entity_ids)} entities and {len(doc_edge_ids)} relationships were extracted from "
                f"{filename}." + (f" Excerpt: \"{first_sentence_with_entities[:200]}\"" if first_sentence_with_entities else "")
            ),
            "entity_ids": sorted(doc_entity_ids),
            "source_document_id": filename,
        })

        for extra_ts in DATE_RE.findall(text)[:5]:
            pass  # dates are surfaced in evidence text; parsing free-form Indian
            # date formats into reliable ISO timestamps without a real date
            # parser risks silently-wrong timeline entries, so we don't
            # fabricate additional dated events from them here.

    # Finalize nodes: community = connected component, centrality = degree/(n-1)
    adjacency = defaultdict(set)
    for edge in edges_by_key.values():
        adjacency[edge["source"]].add(edge["target"])
        adjacency[edge["target"]].add(edge["source"])

    all_node_ids = [node["id"] for node in nodes_by_key.values()]
    component_of = {}
    next_component = 0
    for node_id in all_node_ids:
        if node_id in component_of:
            continue
        stack = [node_id]
        component_of[node_id] = next_component
        while stack:
            current = stack.pop()
            for neighbor in adjacency.get(current, ()):
                if neighbor not in component_of:
                    component_of[neighbor] = next_component
                    stack.append(neighbor)
        next_component += 1

    max_degree = max((len(adjacency.get(nid, ())) for nid in all_node_ids), default=0) or 1
    for key, node in nodes_by_key.items():
        node_id = node["id"]
        degree = len(adjacency.get(node_id, ()))
        node["community"] = component_of.get(node_id, 0)
        node["centrality"] = round(degree / max_degree, 3)
        mentions = node_mention_count.get(key, 1)
        # More independent mentions across documents (not just repeats within
        # one) push confidence up; a single passing mention stays modest.
        doc_spread = len(node_doc_ids.get(key, {""}))
        node["confidence"] = round(min(0.95, 0.55 + 0.1 * min(mentions, 3) + 0.1 * min(doc_spread, 2)), 2)
        if degree >= max(3, max_degree - 1) and max_degree >= 3:
            node["anomaly_flag"] = 1
            node["anomaly_score"] = round(min(0.35, 0.05 * degree), 3)

    nodes = list(nodes_by_key.values())
    edges = list(edges_by_key.values())
    edges.extend(_predicted_links(nodes_by_key, adjacency, case_id, counter))

    # Drop entities that ended up with zero relationships at all (confirmed
    # or predicted -- _predicted_links never links an already-isolated node,
    # since it needs existing neighbors to compare). An isolated node is
    # visual clutter in the Network Explorer with nothing to click through
    # to, so only entities that are actually part of the network are shown
    # there. Nothing is lost: the source text that produced the entity is
    # still preserved in full in that document's evidence record.
    isolated_ids = {node["id"] for node in nodes if not adjacency.get(node["id"])}
    if isolated_ids:
        nodes = [node for node in nodes if node["id"] not in isolated_ids]
        for record in evidence_records:
            record["entity_ids"] = [eid for eid in record["entity_ids"] if eid not in isolated_ids]
        for event in timeline_events:
            event["entity_ids"] = [eid for eid in event["entity_ids"] if eid not in isolated_ids]

    # Alerts: rank the most-connected PERSON/ORGANIZATION/ACCOUNT entities.
    alerts = []
    ranked = sorted(
        (n for n in nodes if n["type"] in ("PERSON", "ORGANIZATION", "ACCOUNT")),
        key=lambda n: (len(adjacency.get(n["id"], ())), n["confidence"]),
        reverse=True,
    )
    for node in ranked[:5]:
        degree = len(adjacency.get(node["id"], ()))
        if degree < 2:
            continue
        score = round(min(0.97, 0.5 + 0.08 * degree), 2)
        severity = "HIGH" if score >= 0.85 else "MEDIUM" if score >= 0.65 else "LOW"
        connected_labels = [
            nodes_by_key[id_lookup[nid]]["label"]
            for nid in list(adjacency.get(node["id"], ()))[:4]
            if nid in id_lookup and id_lookup[nid] in nodes_by_key
        ]
        reasons = [
            f"{node['label']} appears connected to {degree} other extracted entities across the uploaded documents"
            + (f" ({', '.join(connected_labels)})." if connected_labels else "."),
            "AI-generated investigative indicator based on document co-occurrence and pattern extraction — a lead to corroborate, not proof of wrongdoing.",
        ]
        alerts.append({
            "id": f"ALERT-{case_id}-{len(alerts) + 1:03d}",
            "severity": severity,
            "title": f"Convergent investigative indicators: {node['label']}",
            "entity_id": node["id"],
            "score": score,
            "reasons": reasons,
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "evidence": evidence_records,
        "timeline": timeline_events,
        "alerts": alerts,
    }
