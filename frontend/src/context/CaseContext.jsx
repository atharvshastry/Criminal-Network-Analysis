import React from "react";
import { useAuthContext } from "./AuthContext";
import { fetchCases, postAuditLog } from "../services/api";

const CaseContext = React.createContext(null);
const STORAGE_KEY = "tracex.selectedCaseId";

function readStoredCaseId() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredCaseId(caseId) {
  try {
    if (caseId) {
      window.localStorage.setItem(STORAGE_KEY, caseId);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable (private browsing, disabled cookies, etc.);
    // the app still works, it just won't remember the case on reload.
  }
}

// Holds the single, app-wide "active case". Selecting a case anywhere in the
// app updates this context (and persists it to localStorage), so every other
// page picks up the same case automatically instead of asking again.
export function CaseProvider({ children }) {
  const { user } = useAuthContext();
  const [caseId, setCaseIdState] = React.useState(readStoredCaseId);
  const [cases, setCases] = React.useState([]);
  const [casesLoading, setCasesLoading] = React.useState(true);

  const loadCases = React.useCallback(() => {
    setCasesLoading(true);
    return fetchCases()
      .then((payload) => {
        setCases(Array.isArray(payload) ? payload : []);
        return payload;
      })
      .catch(() => {
        setCases([]);
        return [];
      })
      .finally(() => setCasesLoading(false));
  }, []);

  React.useEffect(() => {
    loadCases();
  }, [loadCases]);

  const setCaseId = React.useCallback(
    (nextCaseId) => {
      const normalized = nextCaseId || "";
      setCaseIdState((current) => {
        if (normalized && normalized !== current && user) {
          postAuditLog({
            officer_id: user.id,
            role: user.role,
            action: "SELECT_CASE",
            case_id: normalized,
            target_id: normalized,
          }).catch(() => undefined);
        }
        return normalized;
      });
      writeStoredCaseId(normalized);
    },
    [user],
  );

  const clearCaseId = React.useCallback(() => setCaseId(""), [setCaseId]);

  const selectedCase = React.useMemo(
    () => cases.find((item) => item.id === caseId) || null,
    [cases, caseId],
  );

  const value = React.useMemo(
    () => ({
      caseId,
      setCaseId,
      clearCaseId,
      cases,
      casesLoading,
      refreshCases: loadCases,
      selectedCase,
    }),
    [caseId, setCaseId, clearCaseId, cases, casesLoading, loadCases, selectedCase],
  );

  return <CaseContext.Provider value={value}>{children}</CaseContext.Provider>;
}

export function useCaseContext() {
  const context = React.useContext(CaseContext);
  if (!context) {
    throw new Error("useCase must be used inside CaseProvider.");
  }

  return context;
}
