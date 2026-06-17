"use client";

import React from "react";
import { useAgent } from "../context/agent-context";
import { ChatPanel } from "../components/ChatPanel";
import { TracePanel } from "../components/TracePanel";
import { ContextInspector } from "../components/ContextInspector";

export default function Home() {
  const { connectionState, resetSession } = useAgent();

  const getConnectionStateLabel = () => {
    switch (connectionState) {
      case "CONNECTED":
        return "Operational";
      case "CONNECTING":
        return "Establishing Link...";
      case "RESUMING":
        return "Syncing Recovery State...";
      case "RECONNECTING":
        return "Link Interrupted - Reconnecting...";
      case "DISCONNECTED":
        return "Link Terminated";
    }
  };

  const getConnectionDotClass = () => {
    switch (connectionState) {
      case "CONNECTED":
        return "connected";
      case "CONNECTING":
      case "RESUMING":
      case "RECONNECTING":
        return "reconnecting";
      case "DISCONNECTED":
        return "disconnected";
    }
  };

  const showReconnectToast = connectionState !== "CONNECTED";

  return (
    <div className="cockpit-container">
      {/* 1. Dashboard Header */}
      <header className="cockpit-header">
        <div className="cockpit-brand">
          <span className="cockpit-title">Agent Operations Console</span>
          <span className="cockpit-brand-badge">V1.0-STABLE</span>
        </div>
        
        <div className="cockpit-status-panel">
          <div className="status-indicator">
            <span className={`status-dot ${getConnectionDotClass()}`} />
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
              Link Status:
            </span>
            <span style={{ fontWeight: 600 }}>
              {getConnectionStateLabel()}
            </span>
          </div>

          <button onClick={resetSession} className="btn btn-danger">
            Force Link Reset
          </button>
        </div>
      </header>

      {/* 2. Three-Column Workspace Split */}
      <main className="cockpit-workspace">
        <ChatPanel />
        <TracePanel />
        <ContextInspector />
      </main>

      {/* 3. Non-blocking Reconnection Toast Overlay */}
      {showReconnectToast && (
        <div className="reconnect-toast">
          <div className="reconnect-spinner" />
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--warning)" }}>
              Network Re-routing
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              {connectionState === "RESUMING"
                ? "Restoring state from processed DOM index..."
                : "WebSocket disconnected. Reconnecting with exponential backoff..."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
