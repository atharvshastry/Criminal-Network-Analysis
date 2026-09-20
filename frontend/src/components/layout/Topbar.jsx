import React from "react";
import { useNavigate } from "react-router-dom";
import useAuth from "../../hooks/useAuth";
import useCase from "../../hooks/useCase";
import { useTheme } from "../../context/ThemeContext";

export default function Topbar({ title, subtitle, actions }) {
  const { user, logout } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const { caseId, setCaseId, cases } = useCase();
  const navigate = useNavigate();
  const [showLogoutConfirmation, setShowLogoutConfirmation] = React.useState(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);

  const handleCaseChange = (event) => {
    setCaseId(event.target.value);
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setIsLoggingOut(false);
      setShowLogoutConfirmation(false);
    }
  };

  const roleLabel = user?.role === "senior" ? "Senior Officer" : "Investigator";

  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">INVESTIGATIVE ANALYSIS</div>
        <h1>{title}</h1>
      </div>

      <div className="topbar-actions">
        {subtitle && <span className="topbar-subtitle">{subtitle}</span>}
        {actions}
        <label className="network-case-selector topbar-case-selector" htmlFor="global-case-select">
          <span>Active case</span>
          <select id="global-case-select" value={caseId} onChange={handleCaseChange}>
            <option value="">Select Case</option>
            {cases.map((item) => (
              <option key={item.id} value={item.id}>{item.id} — {item.title}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
          title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
        >
          <span className="theme-toggle-icon" aria-hidden="true">{isDark ? "☀" : "☾"}</span>
          <span>{isDark ? "Light" : "Dark"}</span>
        </button>
        <div className="session-summary">
          <span className="session-status"><span className="security-dot" aria-hidden="true" /> Authenticated {roleLabel.toLowerCase()} session</span>
          <strong>{user?.name}</strong>
          <span>{roleLabel}</span>
        </div>
        <button type="button" className="logout-button" onClick={() => setShowLogoutConfirmation(true)}>
          Logout
        </button>
      </div>

      {showLogoutConfirmation && (
        <div className="logout-confirmation-backdrop" role="presentation">
          <section className="logout-confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="logout-confirmation-title">
            <div className="logout-confirmation-header">
              <span className="logout-confirmation-indicator" aria-hidden="true">!</span>
              <h2 id="logout-confirmation-title">Confirm logout</h2>
            </div>
            <p className="logout-confirmation-message">Are you sure you want to log out of TraceX?</p>
            <p className="logout-confirmation-copy">Your current investigation session will be ended.</p>
            <div className="logout-confirmation-actions">
              <button type="button" className="secondary-button" onClick={() => setShowLogoutConfirmation(false)} disabled={isLoggingOut}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={handleLogout} disabled={isLoggingOut}>
                {isLoggingOut ? "Logging out..." : "Logout"}
              </button>
            </div>
          </section>
        </div>
      )}
    </header>
  );
}
