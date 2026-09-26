import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import useAuth from "../../hooks/useAuth";
import useCase from "../../hooks/useCase";

const baseNavItems = [
  { to: "/", label: "Dashboard" },
  { to: "/assistant", label: "AI Investigation Assistant" },
  { to: "/cases", label: "Cases" },
  { to: "/network", label: "Network Explorer" },
  { to: "/entities", label: "Entities" },
  { to: "/alerts", label: "Alerts" },
  { to: "/evidence", label: "Evidence" },
  { to: "/timeline", label: "Timeline" },
  { to: "/reports", label: "Reports" },
];

const seniorNavItems = [
  { id: "senior-command", label: "Senior Command" },
  { id: "ai-investigation-summary", label: "AI Investigation Summary" },
  { id: "evidence-verification", label: "Evidence Verification" },
];

export default function Sidebar() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { caseId } = useCase();
  const isSenior = user?.role === "senior";

  const handleSeniorNavClick = (sectionId) => {
    if (!caseId) {
      navigate(`/?seniorFeature=${encodeURIComponent(sectionId)}`);
      return;
    }

    const target = document.getElementById(sectionId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    navigate(`/#${sectionId}`);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-mark">TraceX</div>
        <div className="brand-sub">Investigation Intelligence</div>
      </div>

      <nav className="sidebar-nav" aria-label="Primary navigation">
        {baseNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            {item.label}
          </NavLink>
        ))}

        {isSenior && (
          <div className="senior-nav-section">
            <div className="senior-nav-header">SENIOR OFFICER</div>
            {seniorNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="nav-item nav-item-button"
                onClick={() => handleSeniorNavClick(item.id)}
              >
                {item.label}
              </button>
            ))}
            <NavLink className="nav-item" to="/view-activity">View Activity</NavLink>
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        <p>Synthetic investigative data only.</p>
        <p>AI outputs are indicators, not proof.</p>
      </div>
    </aside>
  );
}
