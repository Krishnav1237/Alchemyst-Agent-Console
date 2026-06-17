"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { AgentWebSocketController } from "../lib/ws-controller";
import { ServerMessage, ConnectionState } from "../types/protocol";

// ── Context Types ───────────────────────────────────────────

export interface TextBlock {
  type: "text";
  content: string;
  isFrozen: boolean;
}

export interface ToolCallBlock {
  type: "tool_call";
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export type MessageBlock = TextBlock | ToolCallBlock;

export interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  content?: string; // For user message
  blocks?: MessageBlock[]; // For agent message
}

export interface TokenBatchItem {
  type: "token_batch";
  streamId: string;
  count: number;
  text: string;
  startTime: number;
  durationMs: number;
}

export interface ToolCallItem {
  type: "tool_call";
  callId: string;
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResultItem {
  type: "tool_result";
  callId: string;
  result: Record<string, unknown>;
  timestamp: number;
}

export interface PingItem {
  type: "ping";
  seq: number;
  challenge: string;
  timestamp: number;
}

export interface PongItem {
  type: "pong";
  echo: string;
  timestamp: number;
}

export interface SnapshotItem {
  type: "context_snapshot";
  seq: number;
  contextId: string;
  timestamp: number;
}

export interface StreamEndItem {
  type: "stream_end";
  streamId: string;
  timestamp: number;
}

export interface ErrorItem {
  type: "error";
  code: string;
  message: string;
  timestamp: number;
}

export type TimelineItem =
  | TokenBatchItem
  | ToolCallItem
  | ToolResultItem
  | PingItem
  | PongItem
  | SnapshotItem
  | StreamEndItem
  | ErrorItem;

export interface AgentContextProps {
  connectionState: ConnectionState;
  messages: ChatMessage[];
  timeline: TimelineItem[];
  snapshots: Record<string, Record<string, unknown>[]>;
  selectedIndex: Record<string, number>;
  activeContextId: string | null;
  sendMessage: (content: string) => void;
  setSelectedIndex: (contextId: string, index: number) => void;
  resetSession: () => void;
  simulateDrop: () => void;
}

const AgentContext = createContext<AgentContextProps | undefined>(undefined);

const WS_URL = "ws://localhost:4747/ws";
const MAX_SNAPSHOT_HISTORY = 10;
const MAX_TIMELINE_ENTRIES = 100; // Limit DOM node footprint for windowing/virtualization

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connectionState, setConnectionState] = useState<ConnectionState>("DISCONNECTED");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, Record<string, unknown>[]>>({});
  const [selectedIndex, setSelectedIndexState] = useState<Record<string, number>>({});
  const [activeContextId, setActiveContextId] = useState<string | null>(null);

  const controllerRef = useRef<AgentWebSocketController | null>(null);

  const handleStateChange = (state: ConnectionState) => {
    setConnectionState(state);
  };

  const handleReset = () => {
    setMessages([]);
    setTimeline([]);
    setSnapshots({});
    setSelectedIndexState({});
    setActiveContextId(null);
  };

  const handleEventProcessed = (msg: ServerMessage) => {
    // ── 1. Update Chat Projection ──
    if (msg.type === "TOKEN" || msg.type === "TOOL_CALL" || msg.type === "TOOL_RESULT" || msg.type === "ERROR") {
      setMessages((prevMessages) => {
        const lastMsg = prevMessages[prevMessages.length - 1];
        
        // If there's no previous message or the last message belongs to user, create a new Agent message
        if (!lastMsg || lastMsg.sender === "user") {
          const newAgentMessage: ChatMessage = {
            id: `msg_${Math.random().toString(36).slice(2, 9)}`,
            sender: "agent",
            blocks: [],
          };
          
          if (msg.type === "TOKEN") {
            newAgentMessage.blocks!.push({
              type: "text",
              content: msg.text,
              isFrozen: false,
            });
          } else if (msg.type === "TOOL_CALL") {
            newAgentMessage.blocks!.push({
              type: "tool_call",
              callId: msg.call_id,
              name: msg.tool_name,
              args: msg.args,
            });
          }
          
          return [...prevMessages, newAgentMessage];
        }

        // Otherwise, append to or update blocks of the existing agent message
        const updatedMessages = [...prevMessages];
        const currentAgentMsg = { ...lastMsg };
        const blocks = currentAgentMsg.blocks ? [...currentAgentMsg.blocks] : [];

        if (msg.type === "TOKEN") {
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.type === "text" && !lastBlock.isFrozen) {
            // Append to existing active TextBlock
            blocks[blocks.length - 1] = {
              ...lastBlock,
              content: lastBlock.content + msg.text,
            };
          } else {
            // Create a new TextBlock
            blocks.push({
              type: "text",
              content: msg.text,
              isFrozen: false,
            });
          }
        } else if (msg.type === "TOOL_CALL") {
          // Freeze previous text blocks
          const updatedBlocks = blocks.map((b) =>
            b.type === "text" ? { ...b, isFrozen: true } : b
          );
          // Append new ToolCallBlock
          updatedBlocks.push({
            type: "tool_call",
            callId: msg.call_id,
            name: msg.tool_name,
            args: msg.args,
          });
          currentAgentMsg.blocks = updatedBlocks;
          updatedMessages[updatedMessages.length - 1] = currentAgentMsg;
          return updatedMessages;
        } else if (msg.type === "TOOL_RESULT") {
          // Find matching ToolCallBlock and fill result
          currentAgentMsg.blocks = blocks.map((b) => {
            if (b.type === "tool_call" && b.callId === msg.call_id) {
              return {
                ...b,
                result: msg.result,
              };
            }
            return b;
          });
        }

        currentAgentMsg.blocks = blocks;
        updatedMessages[updatedMessages.length - 1] = currentAgentMsg;
        return updatedMessages;
      });
    }

    // ── 2. Update Timeline Projection (with batching and limits) ──
    setTimeline((prevTimeline) => {
      const updated = [...prevTimeline];

      if (msg.type === "TOKEN") {
        const lastItem = updated[updated.length - 1];
        if (lastItem && lastItem.type === "token_batch" && lastItem.streamId === msg.stream_id) {
          // Batch tokens
          updated[updated.length - 1] = {
            ...lastItem,
            count: lastItem.count + 1,
            text: lastItem.text + msg.text,
            durationMs: Date.now() - lastItem.startTime,
          };
          return updated;
        } else {
          updated.push({
            type: "token_batch",
            streamId: msg.stream_id,
            count: 1,
            text: msg.text,
            startTime: Date.now(),
            durationMs: 0,
          });
        }
      } else if (msg.type === "TOOL_CALL") {
        updated.push({
          type: "tool_call",
          callId: msg.call_id,
          name: msg.tool_name,
          args: msg.args,
          timestamp: Date.now(),
        });
      } else if (msg.type === "TOOL_RESULT") {
        updated.push({
          type: "tool_result",
          callId: msg.call_id,
          result: msg.result,
          timestamp: Date.now(),
        });
      } else if (msg.type === "PING") {
        updated.push({
          type: "ping",
          seq: msg.seq,
          challenge: msg.challenge,
          timestamp: Date.now(),
        });
        // Out-of-band PONG is immediate, reflect it in the timeline too
        updated.push({
          type: "pong",
          echo: msg.challenge,
          timestamp: Date.now(),
        });
      } else if (msg.type === "CONTEXT_SNAPSHOT") {
        updated.push({
          type: "context_snapshot",
          seq: msg.seq,
          contextId: msg.context_id,
          timestamp: Date.now(),
        });
      } else if (msg.type === "STREAM_END") {
        updated.push({
          type: "stream_end",
          streamId: msg.stream_id,
          timestamp: Date.now(),
        });
      } else if (msg.type === "ERROR") {
        updated.push({
          type: "error",
          code: msg.code,
          message: msg.message,
          timestamp: Date.now(),
        });
      }

      // Enforce history windowing to prevent DOM overload (>100 nodes in timeline viewport)
      if (updated.length > MAX_TIMELINE_ENTRIES) {
        return updated.slice(updated.length - MAX_TIMELINE_ENTRIES);
      }
      return updated;
    });

    // ── 3. Update Context Snapshot Projection (with history compaction limits) ──
    if (msg.type === "CONTEXT_SNAPSHOT") {
      const contextId = msg.context_id;
      setActiveContextId(contextId);

      setSnapshots((prevSnaps) => {
        const history = prevSnaps[contextId] ? [...prevSnaps[contextId]] : [];
        
        // Push the new snapshot data
        history.push(msg.data);

        // Enforce max snapshots bounds to prevent memory leaks with large payloads
        let evictedCount = 0;
        let finalHistory = history;
        if (history.length > MAX_SNAPSHOT_HISTORY) {
          evictedCount = history.length - MAX_SNAPSHOT_HISTORY;
          finalHistory = history.slice(evictedCount);
        }

        // Update selected indices
        setSelectedIndexState((prevIdxs) => {
          return {
            ...prevIdxs,
            [contextId]: finalHistory.length - 1, // Focus on newest snapshot automatically
          };
        });

        return {
          ...prevSnaps,
          [contextId]: finalHistory,
        };
      });
    }
  };

  const handleEventLogChange = () => {
    // We already do incremental rendering via handleEventProcessed.
    // This hook is kept for standard event log references.
  };

  useEffect(() => {
    // Instantiate WebSocket Controller
    const controller = new AgentWebSocketController(
      WS_URL,
      handleStateChange,
      handleEventLogChange,
      handleEventProcessed,
      handleReset
    );
    controllerRef.current = controller;
    controller.connect();

    return () => {
      controller.disconnect();
    };
  }, []);

  const sendMessage = (content: string) => {
    if (controllerRef.current) {
      // 1. Instantly append User message in React state
      const userMessage: ChatMessage = {
        id: `user_${Date.now()}`,
        sender: "user",
        content,
      };
      setMessages([userMessage]);
      setTimeline([]); // Clear timeline for a new turn
      
      // 2. Dispatch to controller
      controllerRef.current.sendUserMessage(content);
    }
  };

  const setSelectedIndex = (contextId: string, index: number) => {
    setSelectedIndexState((prev) => ({
      ...prev,
      [contextId]: index,
    }));
  };

  const resetSession = () => {
    if (controllerRef.current) {
      // Request server reset if socket is active
      fetch("http://localhost:4747/reset").catch(() => {});
      controllerRef.current.disconnect();
      handleReset();
      // Reconnect
      setTimeout(() => {
        if (controllerRef.current) {
          controllerRef.current.connect();
        }
      }, 500);
    }
  };

  const simulateDrop = () => {
    if (controllerRef.current) {
      controllerRef.current.simulateDrop();
    }
  };

  return (
    <AgentContext.Provider
      value={{
        connectionState,
        messages,
        timeline,
        snapshots,
        selectedIndex,
        activeContextId,
        sendMessage,
        setSelectedIndex,
        resetSession,
        simulateDrop,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
};

export const useAgent = () => {
  const context = useContext(AgentContext);
  if (context === undefined) {
    throw new Error("useAgent must be used within an AgentProvider");
  }
  return context;
};
