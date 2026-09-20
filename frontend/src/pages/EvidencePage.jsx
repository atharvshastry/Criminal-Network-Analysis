import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import { fetchEvidence, postAuditLog, verifyEvidence } from "../services/api";
import useAuth from "../hooks/useAuth";
import useCase from "../hooks/useCase";

const STATUS_TONE = {
  VERIFIED: "success",
  PENDING: "warning",
  "REQUIRES_REVIEW": "danger",
};

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

function getHashStatus(record) {
  return record?.hash_status || record?.integrity_status || record?.technical_integrity || "HASH UNVERIFIED";
}

function getInvestigationStatus(record) {
  return record?.verification_status || "PENDING";
}

function getIntegrityExplanation(record) {
  return record?.integrity_explanation || "Hash verification confirms the stored evidence file matches the underlying source material at the time of collection. It is a technical integrity check only and does not establish guilt, intent, or wrongdoing.";
}

function getReviewExplanation(record) {
  return record?.verification_note || "Investigation status reflects a human analyst review of relevance, corroboration, and evidentiary strength. It remains distinct from the technical file integrity check.";
}

function getStructuredDetails(record) {
  const details = record?.details || record?.metadata || {};
  if (!details || typeof details !== "object") {
    return [];
  }

  return Object.entries(details)
    .map(([key, value]) => {
      if (value === null || value === undefined || value === "") {
        return null;
      }
      const label = key
        .replace(/_/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
      const displayValue = Array.isArray(value) ? value.join(", ") : value;
      return { label, value: String(displayValue) };
    })
    .filter(Boolean);
}

function getDocumentText(record) {
  if (!record?.document) {
    return [
      "SYNTHETIC DEMONSTRATION DOCUMENT",
      "",
      record?.title || record?.type || "Evidence Document",
      "",
      `Case ID: ${record?.case_id || "UNKNOWN"}`,
      `Document ID: ${record?.id || "UNKNOWN"}`,
      `Source: ${record?.source || "Synthetic source"}`,
      `Timestamp: ${formatTimestamp(record?.timestamp)}`,
      "",
      record?.summary || record?.evidence_note || "Document content unavailable.",
    ].join("\n");
  }

  const document = record.document;
  const lines = [
    "SYNTHETIC DEMONSTRATION DOCUMENT — NOT AN OFFICIAL FIR",
    "",
    document.type || "DOCUMENT",
    "",
    `Document ID: ${document.document_id || record.id}`,
    `Case ID: ${document.case_id || record.case_id}`,
    `Police Station: ${document.police_station || "Synthetic Demo Police Station"}`,
    `District: ${document.district || "Demo District"}`,
    `State: ${document.state || "Demo State"}`,
    `Year: ${document.year || "2026"}`,
    `Date of Registration: ${document.date_of_registration || "01/09/2026"}`,
    `Time of Registration: ${document.time_of_registration || "10:30 AM"}`,
    "",
    "COMPLAINANT / INFORMANT",
    `Name: ${document.complainant || "Synthetic Person A"}`,
    `Contact: ${document.contact || "+91-90000-00000"}`,
    `Address: ${document.address || "Synthetic residential address"}`,
    "",
    "INCIDENT DETAILS",
    `Date of Occurrence: ${document.date_of_occurrence || "01/09/2026"}`,
    `Approximate Time: ${document.time_of_occurrence || "21:15"}`,
    `Place of Occurrence: ${document.place_of_occurrence || "Synthetic site"}`,
    "",
    "OFFENCE / SECTIONS",
    ...(document.offence_sections || []).map((item) => `- ${item}`),
    "",
    "PERSONS / ENTITIES REFERENCED",
    ...(document.persons_referenced || []).map((item) => `- ${item}`),
    "",
    "DESCRIPTION OF INFORMATION",
    document.description || "No narrative available.",
    "",
    "INITIAL INVESTIGATION NOTES",
    ...(document.initial_investigation_notes || []).map((item) => `- ${item}`),
    "",
    "INVESTIGATING OFFICER",
    `Officer ID: ${document.investigating_officer || "DEMO-IO-001"}`,
    `Designation: ${document.designation || "Investigating Officer"}`,
    `Registration Status: ${document.registration_status || "Synthetic Demonstration Record"}`,
    "",
    "DOCUMENT INTEGRITY",
    `Document ID: ${document.document_id || record.id}`,
    `SHA-256: ${document.sha256 || "generated-from-document-content"}`,
    `Integrity: ${document.integrity || "HASH VERIFIED"}`,
    "",
    ...(document.footer || []).map((item) => item),
  ];
  return lines.join("\n");
}

async function computeDocumentHash(text) {
  if (!window || !window.crypto || !window.crypto.subtle) {
    return "generated-from-document-content";
  }

  try {
    const buffer = await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    return Array.from(new Uint8Array(buffer))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "generated-from-document-content";
  }
}

export default function EvidencePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { caseId, cases } = useCase();
  const { user } = useAuth();
  const [records, setRecords] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [verification, setVerification] = React.useState({});
  const [selectedRecord, setSelectedRecord] = React.useState(null);
  const [documentHash, setDocumentHash] = React.useState("generated-from-document-content");
  const evidenceId = searchParams.get("evidenceId") || "";

  React.useEffect(() => {
    let ignore = false;

    setLoading(Boolean(caseId));
    setError("");
    setRecords([]);
    setSelectedRecord(null);

    if (!caseId) {
      setLoading(false);
      return;
    }

    fetchEvidence(caseId)
      .then((payload) => {
        if (!ignore) {
          setRecords(Array.isArray(payload?.records) ? payload.records : []);
          setVerification(
            (Array.isArray(payload?.records) ? payload.records : []).reduce((acc, record) => {
              acc[record.id] = record.verification_status || "PENDING";
              return acc;
            }, {}),
          );
        }
      })
      .catch(() => {
        if (!ignore) {
          setError("Unable to load evidence for the selected case.");
          setRecords([]);
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [caseId]);

  React.useEffect(() => {
    if (!evidenceId || !records.length) {
      return;
    }

    const matchingRecord = records.find((record) => record.id === evidenceId);
    if (matchingRecord) {
      setSelectedRecord(matchingRecord);
      if (user && caseId) {
        postAuditLog({
          officer_id: user.id,
          role: user.role,
          action: "VIEW_EVIDENCE",
          case_id: caseId,
          target_id: matchingRecord.id,
        }).catch(() => undefined);
      }
    }
  }, [caseId, evidenceId, records, user]);

  React.useEffect(() => {
    if (!selectedRecord) {
      setDocumentHash("generated-from-document-content");
      return;
    }

    computeDocumentHash(getDocumentText(selectedRecord)).then(setDocumentHash);
  }, [selectedRecord]);

  const selectedCase = cases.find((item) => item.id === caseId);

  const handleVerificationToggle = async (record) => {
    if (!user || !record?.id || user.role !== "senior") return;
    const nextStatus = verification[record.id] === "VERIFIED" ? "REQUIRES_REVIEW" : "VERIFIED";

    try {
      await verifyEvidence(record.id, nextStatus);
      await postAuditLog({
        officer_id: user.id,
        role: user.role,
        action: nextStatus === "VERIFIED" ? "VERIFY_EVIDENCE" : "REQUIRES_REVIEW",
        case_id: caseId,
        target_id: record.id,
      });
      setVerification((current) => ({ ...current, [record.id]: nextStatus }));
      setRecords((current) =>
        current.map((item) =>
          item.id === record.id ? { ...item, verification_status: nextStatus } : item,
        ),
      );
      if (selectedRecord?.id === record.id) {
        setSelectedRecord((current) => (current ? { ...current, verification_status: nextStatus } : current));
      }
    } catch {
      setError("Unable to update evidence verification status.");
    }
  };

  const handleOpenDocument = async (record) => {
    setSelectedRecord(record);
    if (user) {
      try {
        await postAuditLog({
          officer_id: user.id,
          role: user.role,
          action: "VIEW_EVIDENCE",
          case_id: caseId,
          target_id: record.id,
        });
      } catch {
        // Silent fail for demo audit logging.
      }
    }
  };

  const handleTraceDocument = (record) => {
    const tracePayload = {
      caseId,
      nodeIds: Array.isArray(record?.entity_ids) ? record.entity_ids : [],
      edgeIds: Array.isArray(record?.relationship_ids) ? record.relationship_ids : [],
    };
    sessionStorage.setItem("trace-evidence-context", JSON.stringify(tracePayload));
    navigate("/network");
  };

  const closeDocument = () => setSelectedRecord(null);

  return (
    <AppLayout title="Evidence" subtitle="Case records and artifacts">
      <section className="panel">
        <div className="panel-header">
          <h2>Evidence inventory</h2>
        </div>

        {!caseId ? (
          <p className="panel-copy">Select a case from the top bar to review inventory, source records, and verification state.</p>
        ) : loading ? (
          <div className="state-panel">Loading evidence...</div>
        ) : error ? (
          <div className="state-panel error">{error}</div>
        ) : (
          <>
            <div className="panel-copy" style={{ marginBottom: "14px" }}>
              <strong>{caseId}</strong> — {selectedCase?.title || "Case record"}
            </div>
            <div className="evidence-list">
              {records.length === 0 ? (
                <div className="state-panel empty">No evidence records are currently available for this case.</div>
              ) : (
                records.map((record) => (
                  <div className="evidence-record" key={record.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{record.id}</strong>
                      <span className={`status-badge ${STATUS_TONE[verification[record.id] || getInvestigationStatus(record)] || "warning"}`}>
                        {verification[record.id] || getInvestigationStatus(record)}
                      </span>
                    </div>
                    <span>{record.title || record.type || "Evidence record"}</span>
                    <span>{record.type || "Evidence record"}</span>
                    <span>{record.source || "Source unavailable"}</span>
                    <span>{formatTimestamp(record.timestamp)}</span>
                    <span>Confidence {Math.round((record.confidence || 0) * 100)}%</span>
                    <span className="evidence-integrity">{getHashStatus(record)}</span>
                    <p className="panel-copy" style={{ marginTop: "6px" }}>{record.summary || record.evidence_note || "No narrative summary is available for this synthetic record."}</p>
                    <div className="document-actions">
                      <button type="button" className="secondary-button" onClick={() => handleOpenDocument(record)}>
                        VIEW DOCUMENT
                      </button>
                      {(record.entity_ids?.length || record.relationship_ids?.length) && (
                        <button type="button" className="inline-link" onClick={() => handleTraceDocument(record)}>
                          TRACE IN GRAPH
                        </button>
                      )}
                      {user?.role === "senior" && (
                        <button type="button" className="secondary-button" onClick={() => handleVerificationToggle(record)}>
                          {verification[record.id] === "VERIFIED" ? "REQUIRES REVIEW" : "VERIFY EVIDENCE"}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </section>

      {selectedRecord && (
        <div className="evidence-modal-backdrop" onClick={closeDocument}>
          <div className="evidence-document-modal" onClick={(event) => event.stopPropagation()}>
            <div className="evidence-document-header">
              <h2>Evidence document</h2>
              <button type="button" className="inline-link" onClick={closeDocument}>Close</button>
            </div>

            <div className="evidence-document-paper evidence-document-print">
              <div className="document-watermark">SYNTHETIC DEMO</div>
              <div className="document-header-block">
                <div className="document-kicker">SYNTHETIC DEMONSTRATION DOCUMENT</div>
                <h3>{selectedRecord.document?.type || selectedRecord.type || "DOCUMENT"}</h3>
                <div className="document-subtitle">{selectedRecord.document?.subtitle || "NOT AN OFFICIAL POLICE FIR"}</div>
              </div>

              <div className="document-field-grid">
                <div><strong>Document ID:</strong> {selectedRecord.document?.document_id || selectedRecord.id}</div>
                <div><strong>Case ID:</strong> {selectedRecord.case_id}</div>
                <div><strong>Source:</strong> {selectedRecord.source || "Synthetic source"}</div>
                <div><strong>Timestamp:</strong> {formatTimestamp(selectedRecord.timestamp)}</div>
                <div><strong>Investigation status:</strong> {verification[selectedRecord.id] || getInvestigationStatus(selectedRecord)}</div>
                <div><strong>Hash integrity:</strong> {getHashStatus(selectedRecord)}</div>
              </div>

              {getStructuredDetails(selectedRecord).length > 0 && (
                <div className="document-section">
                  <h4>RECORD DETAILS</h4>
                  <div className="document-field-grid">
                    {getStructuredDetails(selectedRecord).map((entry) => (
                      <div key={`${selectedRecord.id}-${entry.label}`}>
                        <strong>{entry.label}:</strong> {entry.value}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="document-body">
                {selectedRecord.document ? (
                  <>
                    <div className="document-section">
                      <h4>FIRST INFORMATION REPORT</h4>
                      <div className="document-meta-block">
                        <div><strong>FIR / DOCUMENT NUMBER:</strong> {selectedRecord.document.document_number || selectedRecord.document.document_id || selectedRecord.id}</div>
                        <div><strong>CASE ID:</strong> {selectedRecord.case_id}</div>
                        <div><strong>POLICE STATION:</strong> {selectedRecord.document.police_station || "Synthetic Demo Police Station"}</div>
                        <div><strong>DISTRICT:</strong> {selectedRecord.document.district || "Demo District"}</div>
                        <div><strong>STATE:</strong> {selectedRecord.document.state || "Demo State"}</div>
                        <div><strong>YEAR:</strong> {selectedRecord.document.year || "2026"}</div>
                        <div><strong>DATE OF REGISTRATION:</strong> {selectedRecord.document.date_of_registration || "01/09/2026"}</div>
                        <div><strong>TIME OF REGISTRATION:</strong> {selectedRecord.document.time_of_registration || "10:30 AM"}</div>
                      </div>
                    </div>

                    <div className="document-section">
                      <h4>COMPLAINANT / INFORMANT</h4>
                      <div className="document-meta-block">
                        <div><strong>Name:</strong> {selectedRecord.document.complainant || "Synthetic Person A"}</div>
                        <div><strong>Contact:</strong> {selectedRecord.document.contact || "+91-90000-00000"}</div>
                        <div><strong>Address:</strong> {selectedRecord.document.address || "12 Demo Residency, Sector 10, Demo City"}</div>
                      </div>
                    </div>

                    <div className="document-section">
                      <h4>INCIDENT DETAILS</h4>
                      <div className="document-meta-block">
                        <div><strong>Date of Occurrence:</strong> {selectedRecord.document.date_of_occurrence || "31/08/2026"}</div>
                        <div><strong>Approximate Time:</strong> {selectedRecord.document.time_of_occurrence || "21:15"}</div>
                        <div><strong>Place of Occurrence:</strong> {selectedRecord.document.place_of_occurrence || "Demo Commercial Complex, Sector 10"}</div>
                      </div>
                    </div>

                    <div className="document-section">
                      <h4>OFFENCE / SECTIONS</h4>
                      <ul className="document-list">
                        {(selectedRecord.document.offence_sections || []).map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>

                    <div className="document-section">
                      <h4>PERSONS / ENTITIES REFERENCED</h4>
                      <ul className="document-list">
                        {(selectedRecord.document.persons_referenced || []).map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>

                    <div className="document-section">
                      <h4>DESCRIPTION OF INFORMATION</h4>
                      <p>{selectedRecord.document.description || "No description available."}</p>
                    </div>

                    <div className="document-section">
                      <h4>INITIAL INVESTIGATION NOTES</h4>
                      <ul className="document-list">
                        {(selectedRecord.document.initial_investigation_notes || []).map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>

                    <div className="document-section">
                      <h4>INVESTIGATING OFFICER</h4>
                      <div className="document-meta-block">
                        <div><strong>Officer ID:</strong> {selectedRecord.document.investigating_officer || "DEMO-IO-001"}</div>
                        <div><strong>Designation:</strong> {selectedRecord.document.designation || "Investigating Officer"}</div>
                        <div><strong>Registration Status:</strong> {selectedRecord.document.registration_status || "Synthetic Demonstration Record"}</div>
                      </div>
                    </div>

                    <div className="document-section">
                      <h4>DOCUMENT INTEGRITY</h4>
                      <div className="document-meta-block">
                        <div><strong>Document ID:</strong> {selectedRecord.document.document_id || selectedRecord.id}</div>
                        <div><strong>SHA-256:</strong> {documentHash}</div>
                        <div><strong>Technical integrity:</strong> {getHashStatus(selectedRecord)}</div>
                        <div><strong>Hash explanation:</strong> {getIntegrityExplanation(selectedRecord)}</div>
                      </div>
                    </div>

                    <div className="document-section">
                      <h4>INVESTIGATION REVIEW</h4>
                      <div className="document-meta-block">
                        <div><strong>Investigation status:</strong> {verification[selectedRecord.id] || getInvestigationStatus(selectedRecord)}</div>
                        <div><strong>Review note:</strong> {getReviewExplanation(selectedRecord)}</div>
                      </div>
                    </div>

                    <div className="document-footer">
                      {(selectedRecord.document.footer || []).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="document-section">
                    <h4>DOCUMENT CONTENT</h4>
                    <pre>{getDocumentText(selectedRecord)}</pre>
                  </div>
                )}
              </div>

              {(selectedRecord.entity_ids?.length || selectedRecord.relationship_ids?.length || selectedRecord.related_alerts?.length) && (
                <div className="document-links-panel">
                  <div className="document-link-section">
                    <h5>REFERENCED ENTITIES</h5>
                    <ul>
                      {(selectedRecord.entity_ids || []).map((entityId) => (
                        <li key={entityId}>{entityId}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="document-link-section">
                    <h5>RELATED RELATIONSHIPS</h5>
                    <ul>
                      {(selectedRecord.relationship_ids || []).map((relationshipId) => (
                        <li key={relationshipId}>{relationshipId}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="document-link-section">
                    <h5>RELATED ALERTS</h5>
                    <ul>
                      {(selectedRecord.related_alerts || []).map((alertId) => (
                        <li key={alertId}>{alertId}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>

            <div className="document-actions-bar">
              <button type="button" className="secondary-button" onClick={() => handleTraceDocument(selectedRecord)}>
                TRACE IN GRAPH
              </button>
              {user?.role === "senior" && (
                <button type="button" className="secondary-button" onClick={() => handleVerificationToggle(selectedRecord)}>
                  {verification[selectedRecord.id] === "VERIFIED" ? "REQUIRES REVIEW" : "VERIFY EVIDENCE"}
                </button>
              )}
              <button type="button" className="secondary-button" onClick={() => window.print()}>
                PRINT / SAVE DOCUMENT
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
