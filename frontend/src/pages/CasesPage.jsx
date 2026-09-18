import React from "react";
import { NavLink } from "react-router-dom";
import AppLayout from "../components/layout/AppLayout";
import { fetchCases } from "../services/api";

export default function CasesPage() {
  const [cases, setCases] = React.useState([]);

  React.useEffect(() => {
    fetchCases()
      .then(setCases)
      .catch(() => setCases([]));
  }, []);

  return (
    <AppLayout title="Cases" subtitle="Live case inventory">
      <section className="panel">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Entities</th>
                <th>Alerts</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((caseItem) => (
                <tr key={caseItem.id}>
                  <td>
                    <NavLink to={`/cases/${caseItem.id}`}>{caseItem.id}</NavLink>
                  </td>
                  <td>{caseItem.title}</td>
                  <td>{caseItem.status}</td>
                  <td>
                    <span className={`status-badge ${caseItem.priority.toLowerCase()}`}>{caseItem.priority}</span>
                  </td>
                  <td>{caseItem.entities}</td>
                  <td>{caseItem.alerts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppLayout>
  );
}
