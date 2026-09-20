import React from "react";
import { useNavigate } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import useCase from "../hooks/useCase";
import { uploadCase } from "../services/api";

const ALLOWED_EXTENSIONS = [".pdf", ".txt", ".csv", ".docx", ".json", ".md"];
const ALLOWED_EXTENSIONS_ATTR = ALLOWED_EXTENSIONS.join(",");
const MAX_FILES = 15;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function fileExtension(filename) {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export default function NewCasePage() {
  const navigate = useNavigate();
  const { setCaseId, refreshCases } = useCase();

  const [title, setTitle] = React.useState("");
  const [priority, setPriority] = React.useState("Medium");
  const [files, setFiles] = React.useState([]);
  const [error, setError] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isDragActive, setIsDragActive] = React.useState(false);
  const fileInputRef = React.useRef(null);

  const addFiles = (incoming) => {
    setError("");
    const existingKeys = new Set(files.map(fileKey));
    const accepted = [];
    const rejected = [];

    for (const file of incoming) {
      const ext = fileExtension(file.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        rejected.push(`${file.name} (unsupported type)`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} (over 15MB)`);
        continue;
      }
      if (existingKeys.has(fileKey(file))) {
        continue;
      }
      existingKeys.add(fileKey(file));
      accepted.push(file);
    }

    setFiles((current) => {
      const merged = [...current, ...accepted];
      if (merged.length > MAX_FILES) {
        setError(`Only ${MAX_FILES} files are allowed per case — extra files were not added.`);
        return merged.slice(0, MAX_FILES);
      }
      return merged;
    });

    if (rejected.length) {
      setError((current) => {
        const rejectionMessage = `Skipped: ${rejected.join(", ")}.`;
        return current ? `${current} ${rejectionMessage}` : rejectionMessage;
      });
    }
  };

  const handleFileInputChange = (event) => {
    addFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragActive(false);
    addFiles(Array.from(event.dataTransfer.files || []));
  };

  const removeFile = (key) => {
    setFiles((current) => current.filter((file) => fileKey(file) !== key));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      setError("Enter a case title.");
      return;
    }
    if (files.length === 0) {
      setError("Upload at least one report to analyze.");
      return;
    }

    setError("");
    setIsSubmitting(true);
    try {
      const newCase = await uploadCase({ title: trimmedTitle, priority, status: "Active", files });
      await refreshCases();
      setCaseId(newCase.id);
      navigate(`/cases/${newCase.id}`);
    } catch (submitError) {
      setError(submitError.message || "Unable to create the case from the uploaded documents.");
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout title="New Case" subtitle="Upload reports to build and analyze a case instantly">
      <section className="panel">
        <div className="panel-header">
          <h2>Create case from documents</h2>
        </div>
        <p className="panel-copy">
          Upload FIRs, call/financial records, or notes in PDF, TXT, CSV, DOCX, or JSON format. TraceX extracts
          entities and relationships from the documents and builds an explorable case immediately — no waiting on
          an offline pipeline run. This is a fast, rule-based first pass: treat extracted links as investigative
          leads to verify, not confirmed facts.
        </p>

        <form className="new-case-form" onSubmit={handleSubmit} noValidate>
          <label htmlFor="case-title">Case title</label>
          <input
            id="case-title"
            name="title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. FIR-2026-00601 — Cyber Fraud Complaint"
            disabled={isSubmitting}
          />

          <label htmlFor="case-priority">Priority</label>
          <select
            id="case-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            disabled={isSubmitting}
          >
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>

          <label htmlFor="case-files">Reports</label>
          <div
            className={`upload-dropzone${isDragActive ? " is-active" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragActive(true);
            }}
            onDragLeave={() => setIsDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                fileInputRef.current?.click();
              }
            }}
          >
            <p>Drag and drop files here, or click to browse.</p>
            <p className="upload-dropzone-hint">
              Accepted: {ALLOWED_EXTENSIONS.join(", ")} · up to {MAX_FILES} files · 15MB each
            </p>
            <input
              ref={fileInputRef}
              id="case-files"
              type="file"
              multiple
              accept={ALLOWED_EXTENSIONS_ATTR}
              onChange={handleFileInputChange}
              disabled={isSubmitting}
              hidden
            />
          </div>

          {files.length > 0 && (
            <ul className="upload-file-list">
              {files.map((file) => (
                <li key={fileKey(file)}>
                  <span className="upload-file-name">{file.name}</span>
                  <span className="upload-file-size">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="upload-file-remove"
                    onClick={() => removeFile(fileKey(file))}
                    disabled={isSubmitting}
                    aria-label={`Remove ${file.name}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <div className="login-error" role="alert">{error}</div>}

          <button type="submit" className="primary-button" disabled={isSubmitting}>
            {isSubmitting ? "Analyzing documents…" : "Create case & analyze"}
          </button>
        </form>
      </section>
    </AppLayout>
  );
}
