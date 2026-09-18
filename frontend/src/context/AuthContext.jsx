import React from "react";
import {
  clearStoredUser,
  getStoredUser,
  loginWithDemoCredentials,
  storeUser,
} from "../services/auth";
import { endActivitySession, sendActivityHeartbeat, startActivitySession } from "../services/api";

const AuthContext = React.createContext(null);
const ACTIVITY_SESSION_KEY = "nexus.demo.activity-session";

async function recordAuditEvent(entry) {
  try {
    await fetch("/api/audit-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // Demo-only audit storage should fail silently to keep the app working.
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = React.useState(() => getStoredUser());
  const [isLoading, setIsLoading] = React.useState(false);

  const login = async (username, password) => {
    setIsLoading(true);
    try {
      const authenticatedUser = await loginWithDemoCredentials(username, password);
      setUser(authenticatedUser);
      storeUser(authenticatedUser);
      let session = null;
      if (authenticatedUser.role === "investigator") {
        try {
          session = await startActivitySession(authenticatedUser.id, authenticatedUser.role);
          window.localStorage.setItem(ACTIVITY_SESSION_KEY, session.session_id);
        } catch {
          session = null;
        }
      }
      await recordAuditEvent({
        officer_id: authenticatedUser.id,
        role: authenticatedUser.role,
        action: "LOGIN",
        case_id: null,
        target_id: null,
        session_id: session?.session_id || null,
      });
      return authenticatedUser;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    if (user) {
      const sessionId = window.localStorage.getItem(ACTIVITY_SESSION_KEY);
      if (user.role === "investigator" && sessionId) {
        await endActivitySession(user.id, sessionId).catch(() => undefined);
      }
      await recordAuditEvent({
        officer_id: user.id,
        role: user.role,
        action: "LOGOUT",
        case_id: null,
        target_id: null,
        session_id: sessionId,
      });
      window.localStorage.removeItem(ACTIVITY_SESSION_KEY);
    }
    clearStoredUser();
    setUser(null);
  };

  React.useEffect(() => {
    if (!user || user.role !== "investigator") {
      return undefined;
    }

    const heartbeat = () => {
      const sessionId = window.localStorage.getItem(ACTIVITY_SESSION_KEY);
      if (sessionId) {
        sendActivityHeartbeat(user.id, sessionId).catch(() => undefined);
      }
    };
    const interval = window.setInterval(heartbeat, 30000);
    heartbeat();
    return () => window.clearInterval(interval);
  }, [user]);

  const value = {
    user,
    role: user?.role || null,
    isAuthenticated: Boolean(user),
    isLoading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return context;
}
