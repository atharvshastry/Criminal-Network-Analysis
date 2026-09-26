import { jsPDF } from "jspdf";

// Client-side PDF export for the investigation report (Reports page). This
// is deliberately separate from the "Print Report" button, which reuses the
// app's existing window.print() + @media print pattern (see EvidencePage.jsx
// / styles.css) -- this instead produces a real, selectable-text .pdf file
// with no backend involvement, using the exact same `report` object the
// Reports page already fetched from POST /api/reports/generate. Nothing
// here re-derives or re-fetches report data; it only lays the same content
// out onto a page.

const PAGE_WIDTH = 595.28; // A4 pt
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINE_HEIGHT = 14;

function formatDateTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function pct(value) {
  const number = Number(value) || 0;
  return `${Math.round(number * 100)}%`;
}

// Small stateful cursor so every draw helper can just "keep writing" and
// break to a new page automatically instead of every call site tracking Y.
function createCursor(doc) {
  let y = MARGIN;
  const ensureSpace = (height) => {
    if (y + height > PAGE_HEIGHT - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  };
  return {
    get y() { return y; },
    advance(amount) { y += amount; },
    ensureSpace,
    moveTo(value) { y = value; },
  };
}

function drawHeading(doc, cursor, text) {
  cursor.ensureSpace(26);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 30, 45);
  doc.text(text.toUpperCase(), MARGIN, cursor.y);
  cursor.advance(6);
  doc.setDrawColor(200, 205, 214);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursor.y, PAGE_WIDTH - MARGIN, cursor.y);
  cursor.advance(16);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(40, 46, 58);
}

function drawParagraph(doc, cursor, text, options = {}) {
  const { fontSize = 9.5, color = [40, 46, 58], gapAfter = 10, bold = false } = options;
  doc.setFont("helvetica", bold ? "bold" : "normal");
  doc.setFontSize(fontSize);
  doc.setTextColor(...color);
  const lines = doc.splitTextToSize(text || "", CONTENT_WIDTH);
  for (const line of lines) {
    cursor.ensureSpace(LINE_HEIGHT);
    doc.text(line, MARGIN, cursor.y);
    cursor.advance(LINE_HEIGHT);
  }
  cursor.advance(gapAfter);
}

function drawBulletList(doc, cursor, items, options = {}) {
  const { fontSize = 9.5, color = [40, 46, 58] } = options;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(fontSize);
  doc.setTextColor(...color);
  for (const item of items) {
    const lines = doc.splitTextToSize(item, CONTENT_WIDTH - 14);
    lines.forEach((line, index) => {
      cursor.ensureSpace(LINE_HEIGHT);
      doc.text(index === 0 ? `-  ${line}` : `   ${line}`, MARGIN, cursor.y);
      cursor.advance(LINE_HEIGHT);
    });
  }
  cursor.advance(6);
}

function drawEmpty(doc, cursor, message) {
  drawParagraph(doc, cursor, message, { color: [120, 128, 140], gapAfter: 12 });
}

export async function downloadReportPdf(report) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const cursor = createCursor(doc);

  // --- Header: case / investigation summary + metadata (sections 1, 12) ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(90, 96, 108);
  doc.text("TRACEX / INVESTIGATION REPORT", MARGIN, cursor.y);
  doc.text((report.case?.priority || "").toUpperCase(), PAGE_WIDTH - MARGIN, cursor.y, { align: "right" });
  cursor.advance(20);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(15, 22, 35);
  doc.text(report.case?.id || "UNKNOWN CASE", MARGIN, cursor.y);
  cursor.advance(20);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(60, 68, 82);
  doc.text(report.case?.title || "Untitled case", MARGIN, cursor.y);
  cursor.advance(16);

  doc.setFontSize(8.5);
  doc.setTextColor(110, 118, 130);
  doc.text(
    `${report.case?.status || "STATUS UNKNOWN"} - Generated ${formatDateTime(report.generated_at)} by ${report.generated_by || "TraceX Investigator"}`,
    MARGIN, cursor.y,
  );
  cursor.advance(10);
  doc.text(`Report ID: ${report.report_id || "N/A"}`, MARGIN, cursor.y);
  cursor.advance(20);
  doc.setDrawColor(150, 158, 170);
  doc.setLineWidth(1);
  doc.line(MARGIN, cursor.y, PAGE_WIDTH - MARGIN, cursor.y);
  cursor.advance(20);

  // --- 10. AI-generated executive summary (based only on retrieved data) ---
  drawHeading(doc, cursor, "AI-Generated Executive Summary");
  const summary = report.executive_summary || {};
  if (summary.generated && summary.text) {
    drawParagraph(doc, cursor, summary.text, { gapAfter: 14 });
  } else {
    drawEmpty(doc, cursor, summary.message || "Insufficient evidence found in the available case data to generate an executive summary.");
  }

  // --- 2. Investigated person/entity ---
  drawHeading(doc, cursor, "Investigated Entity");
  if (report.primary_entity) {
    drawParagraph(doc, cursor, `${report.primary_entity.name} (${report.primary_entity.id}) - Type: ${report.primary_entity.type}`, { bold: true, gapAfter: 4 });
    drawParagraph(doc, cursor, `Network centrality: ${report.primary_entity.centrality ?? "N/A"}   |   Confidence: ${report.primary_entity.confidence != null ? pct(report.primary_entity.confidence) : "N/A"}`, { color: [110, 118, 130] });
  } else {
    drawEmpty(doc, cursor, "No entities are available in this case's network graph to investigate.");
  }

  // --- 3. Key connected entities ---
  drawHeading(doc, cursor, "Key Connected Entities");
  if (report.key_entities?.length) {
    report.key_entities.forEach((entity) => {
      const rel = entity.relationship_to_primary;
      const relText = rel ? `${rel.type} (${rel.status.toUpperCase()}, confidence ${pct(rel.confidence)})` : "connection type unavailable";
      drawParagraph(doc, cursor, `${entity.name} (${entity.id}) - ${entity.type}`, { bold: true, gapAfter: 2 });
      drawParagraph(doc, cursor, `Connected via: ${relText}`, { color: [110, 118, 130], fontSize: 8.5, gapAfter: 8 });
    });
  } else {
    drawEmpty(doc, cursor, "No directly connected entities were found for the investigated entity.");
  }

  // --- 4. Important relationship paths ---
  drawHeading(doc, cursor, "Important Relationship Paths");
  if (report.connection_paths?.length) {
    report.connection_paths.forEach((path) => {
      const chain = path.path.map((node) => node.name).join("  ->  ");
      drawParagraph(doc, cursor, chain, { fontSize: 8.5, gapAfter: 2 });
      if (path.relationship_types?.length) {
        drawParagraph(doc, cursor, `via: ${path.relationship_types.join(", ")}`, { color: [110, 118, 130], fontSize: 8, gapAfter: 8 });
      }
    });
  } else {
    drawEmpty(doc, cursor, "No alert-linked relationship paths were found from the investigated entity.");
  }

  // --- 5. Graph/network summary ---
  drawHeading(doc, cursor, "Network Summary");
  const summaryNet = report.network_summary || {};
  drawBulletList(doc, cursor, [
    `${summaryNet.entity_count ?? 0} entities across ${summaryNet.community_count ?? 0} detected communities.`,
    `${summaryNet.relationship_count ?? 0} total relationships: ${summaryNet.confirmed_relationship_count ?? 0} confirmed, ${summaryNet.predicted_relationship_count ?? 0} predicted/AI-inferred.`,
    ...(summaryNet.entity_type_breakdown || []).map(([type, count]) => `${type}: ${count}`),
  ]);

  // --- 6. Key findings and alerts ---
  drawHeading(doc, cursor, "Key Findings & Alerts");
  if (report.alerts?.records?.length) {
    report.alerts.records.forEach((alert) => {
      drawParagraph(doc, cursor, `[${alert.severity}] ${alert.title} (entity ${alert.entity_id}, score ${alert.score ?? "N/A"})`, { bold: true, gapAfter: 2 });
      if (alert.reasons?.length) {
        drawBulletList(doc, cursor, alert.reasons, { fontSize: 8.5, color: [110, 118, 130] });
      }
    });
  } else {
    drawEmpty(doc, cursor, "No alerts are recorded for this case.");
  }

  // --- 8. Confirmed vs predicted relationships ---
  drawHeading(doc, cursor, "Confirmed vs Predicted Relationships");
  const relationships = report.relationships || {};
  drawParagraph(doc, cursor, `CONFIRMED (${relationships.confirmed_total ?? 0} total, showing ${relationships.confirmed?.length ?? 0}):`, { bold: true, gapAfter: 4 });
  if (relationships.confirmed?.length) {
    drawBulletList(doc, cursor, relationships.confirmed.map((rel) =>
      `${rel.source_name} --[${rel.type}]--> ${rel.target_name} (confidence ${pct(rel.confidence)})`));
  } else {
    drawEmpty(doc, cursor, "No confirmed relationships are recorded for this case.");
  }
  drawParagraph(doc, cursor, `PREDICTED / AI-INFERRED (${relationships.predicted_total ?? 0} total, showing ${relationships.predicted?.length ?? 0}) -- unconfirmed leads, not established facts:`, { bold: true, gapAfter: 4 });
  if (relationships.predicted?.length) {
    drawBulletList(doc, cursor, relationships.predicted.map((rel) =>
      `${rel.source_name} --[${rel.type}]--> ${rel.target_name} (confidence ${pct(rel.confidence)})`));
  } else {
    drawEmpty(doc, cursor, "No predicted/AI-inferred relationships are recorded for this case.");
  }

  // --- 7. Supporting evidence ---
  drawHeading(doc, cursor, "Supporting Evidence");
  if (report.evidence?.records?.length) {
    report.evidence.records.forEach((record) => {
      drawParagraph(doc, cursor, `${record.title} (${record.id})`, { bold: true, gapAfter: 2 });
      drawParagraph(doc, cursor, `Source: ${record.source}   |   Timestamp: ${formatDateTime(record.timestamp)}   |   Status: ${record.verification_status}`, { color: [110, 118, 130], fontSize: 8.5, gapAfter: 2 });
      if (record.summary) {
        drawParagraph(doc, cursor, record.summary, { fontSize: 8.5, gapAfter: 8 });
      }
    });
  } else {
    drawEmpty(doc, cursor, "No supporting evidence records are available for this case.");
  }

  // --- 9. Investigation timeline ---
  drawHeading(doc, cursor, "Investigation Timeline");
  if (report.timeline?.records?.length) {
    report.timeline.records.forEach((event) => {
      drawParagraph(doc, cursor, `${formatDateTime(event.timestamp)} - ${event.title}`, { bold: true, gapAfter: 2 });
      if (event.description) {
        drawParagraph(doc, cursor, event.description, { fontSize: 8.5, color: [110, 118, 130], gapAfter: 8 });
      }
    });
  } else {
    drawEmpty(doc, cursor, "No dated timeline events are available for this case.");
  }

  // --- 11. Investigation limitations / insufficient evidence ---
  drawHeading(doc, cursor, "Investigation Limitations");
  if (report.limitations?.length) {
    drawBulletList(doc, cursor, report.limitations);
  } else {
    drawParagraph(doc, cursor, "No limitations were identified for this report.", { color: [110, 118, 130] });
  }

  // Footer metadata on every page (section 12).
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(140, 148, 160);
    doc.text(
      `${report.report_id || ""}   -   ${report.case?.id || ""}   -   Generated ${formatDateTime(report.generated_at)}   -   Page ${page} of ${pageCount}`,
      MARGIN, PAGE_HEIGHT - 24,
    );
  }

  doc.save(`${report.report_id || "tracex-report"}.pdf`);
}
