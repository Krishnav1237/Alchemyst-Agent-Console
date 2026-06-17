"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAgent, TimelineItem } from "../context/agent-context";

export const TracePanel: React.FC = () => {
  const { timeline } = useAgent();
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState<string>("");
  const [highlightedCallId, setHighlightedCallId] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll timeline to bottom on new event
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline]);

  // Bidirectional highlighting listener
  useEffect(() => {
    const handleScrollToTimeline = (e: Event) => {
      const customEvent = e as CustomEvent<{ callId: string }>;
      const callId = customEvent.detail.callId;
      setHighlightedCallId(callId);

      const element = document.querySelector(`[data-row-call-id="${callId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.add("highlight-flash");
        setTimeout(() => {
          element.classList.remove("highlight-flash");
        }, 1500);
      }
    };

    window.addEventListener("scroll-to-timeline", handleScrollToTimeline);
    return () => {
      window.removeEventListener("scroll-to-timeline", handleScrollToTimeline);
    };
  }, []);

  const handleRowClick = (item: TimelineItem) => {
    if (item.type === "tool_call" || item.type === "tool_result") {
      setHighlightedCallId(item.callId);
      // Dispatch scroll-to-chat event
      const event = new CustomEvent("scroll-to-call", {
        detail: { callId: item.callId },
      });
      window.dispatchEvent(event);
    }
  };

  const getFilteredTimeline = () => {
    return timeline.filter((item) => {
      // 1. Apply Type Filter
      if (filter !== "ALL") {
        if (filter === "TOKEN" && item.type !== "token_batch") return false;
        if (filter === "TOOL" && item.type !== "tool_call" && item.type !== "tool_result") return false;
        if (filter === "HEARTBEAT" && item.type !== "ping" && item.type !== "pong") return false;
        if (filter === "CONTEXT" && item.type !== "context_snapshot") return false;
        if (filter === "ERROR" && item.type !== "error") return false;
      }

      // 2. Apply Text Search
      if (search.trim()) {
        const query = search.toLowerCase();
        if (item.type === "token_batch") {
          return item.text.toLowerCase().includes(query);
        }
        if (item.type === "tool_call") {
          return (
            item.name.toLowerCase().includes(query) ||
            JSON.stringify(item.args).toLowerCase().includes(query)
          );
        }
        if (item.type === "tool_result") {
          return JSON.stringify(item.result).toLowerCase().includes(query);
        }
        if (item.type === "error") {
          return item.message.toLowerCase().includes(query) || item.code.toLowerCase().includes(query);
        }
        if (item.type === "ping") {
          return item.challenge.toLowerCase().includes(query);
        }
        if (item.type === "pong") {
          return item.echo.toLowerCase().includes(query);
        }
        return false;
      }

      return true;
    });
  };

  const renderItemContent = (item: TimelineItem) => {
    switch (item.type) {
      case "token_batch":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-token">Token Batch</span>
              <span className="trace-time">+{Math.round(item.durationMs)}ms</span>
            </div>
            <div className="trace-summary">
              Streamed {item.count} tokens: &quot;{item.text.slice(0, 80)}
              {item.text.length > 80 ? "..." : ""}&quot;
            </div>
          </>
        );

      case "tool_call":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-tool_call">Tool Call</span>
              <span className="trace-time">ID: {item.callId}</span>
            </div>
            <div className="trace-summary">
              Invoked <strong>{item.name}</strong>
            </div>
            <div className="trace-details">
              args: {JSON.stringify(item.args)}
            </div>
          </>
        );

      case "tool_result":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-tool_result">Tool Result</span>
              <span className="trace-time">ID: {item.callId}</span>
            </div>
            <div className="trace-summary">
              Returned success result
            </div>
            <div className="trace-details">
              result: {JSON.stringify(item.result)}
            </div>
          </>
        );

      case "ping":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-ping">Heartbeat Ping</span>
              <span className="trace-time">seq: {item.seq}</span>
            </div>
            <div className="trace-summary">
              Challenge: &quot;{item.challenge || "<EMPTY>"}&quot;
            </div>
          </>
        );

      case "pong":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-pong">Heartbeat Pong</span>
            </div>
            <div className="trace-summary">
              Echoed challenge: &quot;{item.echo || "<EMPTY>"}&quot;
            </div>
          </>
        );

      case "context_snapshot":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-context">Context Snapshot</span>
              <span className="trace-time">seq: {item.seq}</span>
            </div>
            <div className="trace-summary">
              Updated snapshot context: &quot;{item.contextId}&quot;
            </div>
          </>
        );

      case "stream_end":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-stream_end">Stream End</span>
            </div>
            <div className="trace-summary">
              Completed response stream: &quot;{item.streamId}&quot;
            </div>
          </>
        );

      case "error":
        return (
          <>
            <div className="trace-row-header">
              <span className="trace-type-badge badge-error">Protocol Error</span>
              <span className="trace-time">code: {item.code}</span>
            </div>
            <div className="trace-summary" style={{ color: "var(--danger)" }}>
              {item.message}
            </div>
          </>
        );
    }
  };

  const filteredItems = getFilteredTimeline();

  return (
    <div className="panel trace-panel">
      <div className="panel-header">
        <span className="panel-title">Trace Operations Log</span>
      </div>
      <div className="panel-content">
        <div className="trace-filter-bar">
          <select
            className="trace-filter-select"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="ALL">All Events</option>
            <option value="TOKEN">Tokens</option>
            <option value="TOOL">Tools</option>
            <option value="HEARTBEAT">Heartbeats</option>
            <option value="CONTEXT">Snapshots</option>
            <option value="ERROR">Errors</option>
          </select>
          <input
            type="text"
            className="trace-search"
            placeholder="Search trace details..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="trace-list-viewport">
          {filteredItems.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", textAlign: "center", marginTop: "20px" }}>
              No trace logs match search filter.
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const callId = (item.type === "tool_call" || item.type === "tool_result") ? item.callId : undefined;
              const isHighlighted = callId !== undefined && callId === highlightedCallId;

              return (
                <div
                  key={index}
                  data-row-call-id={callId}
                  className={`trace-row ${isHighlighted ? "highlight-flash" : ""}`}
                  onClick={() => handleRowClick(item)}
                >
                  {renderItemContent(item)}
                </div>
              );
            })
          )}
          <div ref={listEndRef} />
        </div>
      </div>
    </div>
  );
};
