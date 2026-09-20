import React from "react";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

export default function AppLayout({ title, subtitle, actions, children }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="content-shell">
        <Topbar title={title} subtitle={subtitle} actions={actions} />
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
