"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAgent, MessageBlock } from "../context/agent-context";

export const ChatPanel: React.FC = () => {
  const { messages, sendMessage, connectionState } = useAgent();
  const [inputValue, setInputValue] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [highlightedCallId, setHighlightedCallId] = useState<string | null>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Bidirectional highlighting listener
  useEffect(() => {
    const handleScrollToCall = (e: Event) => {
      const customEvent = e as CustomEvent<{ callId: string }>;
      const callId = customEvent.detail.callId;
      setHighlightedCallId(callId);
      
      // Find the element in DOM and scroll it
      const element = document.querySelector(`[data-call-id="${callId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.add("highlight-flash");
        setTimeout(() => {
          element.classList.remove("highlight-flash");
        }, 1500);
      }
    };

    window.addEventListener("scroll-to-call", handleScrollToCall);
    return () => {
      window.removeEventListener("scroll-to-call", handleScrollToCall);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || connectionState !== "CONNECTED") return;
    sendMessage(inputValue.trim());
    setInputValue("");
  };

  const handleBlockClick = (callId: string) => {
    // Trigger scroll-to-timeline-row event
    const event = new CustomEvent("scroll-to-timeline", { detail: { callId } });
    window.dispatchEvent(event);
  };

  const renderBlock = (block: MessageBlock, index: number) => {
    if (block.type === "text") {
      return (
        <div key={index} className="text-block">
          {block.content}
        </div>
      );
    }

    const isResolved = !!block.result;
    const isHighlighted = block.callId === highlightedCallId;

    return (
      <div
        key={block.callId}
        data-call-id={block.callId}
        className={`tool-card ${isResolved ? "resolved" : ""} ${isHighlighted ? "highlight-flash" : ""}`}
        onClick={() => handleBlockClick(block.callId)}
        style={{ cursor: "pointer" }}
      >
        <div className="tool-card-header">
          <div className="tool-name-container">
            <svg
              style={{ width: "14px", height: "14px", fill: "currentColor" }}
              viewBox="0 0 24 24"
            >
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12c0,0.31,0.04,0.64,0.09,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
            <span className="tool-name-tag">{block.name}</span>
          </div>
          <span className="tool-status-tag">{isResolved ? "resolved" : "executing"}</span>
        </div>
        <pre className="tool-args-pre">
          {JSON.stringify(block.args, null, 2)}
        </pre>
        {block.result && (
          <pre className="tool-result-pre">
            {JSON.stringify(block.result, null, 2)}
          </pre>
        )}
      </div>
    );
  };

  const isInputDisabled = connectionState !== "CONNECTED";

  return (
    <div className="panel chat-panel">
      <div className="panel-header">
        <span className="panel-title">Dialogue Channel</span>
      </div>
      <div className="panel-content">
        <div className="chat-history">
          {messages.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", marginTop: "24px" }}>
              Ready for transmission. Submit a query to activate.
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`message-container ${msg.sender === "user" ? "user" : "agent"}`}
              >
                <span className="message-sender">
                  {msg.sender === "user" ? "Client" : "Agent"}
                </span>
                {msg.sender === "user" ? (
                  <div className="user-bubble">{msg.content}</div>
                ) : (
                  msg.blocks?.map((block, i) => renderBlock(block, i))
                )}
              </div>
            ))
          )}
          <div ref={chatEndRef} />
        </div>
        <form onSubmit={handleSubmit} className="chat-input-bar">
          <input
            type="text"
            className="chat-input"
            placeholder={
              connectionState === "CONNECTED"
                ? "Send command message..."
                : connectionState === "RESUMING"
                ? "Replaying stream recovery log..."
                : "Awaiting socket connection liveness..."
            }
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isInputDisabled}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isInputDisabled || !inputValue.trim()}
          >
            Transmit
          </button>
        </form>
      </div>
    </div>
  );
};
