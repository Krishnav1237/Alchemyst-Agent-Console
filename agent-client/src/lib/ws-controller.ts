import {
  ServerMessage,
  ClientMessage,
  ConnectionState,
  ToolCallStatus,
  StreamState,
} from "../types/protocol";
import { isServerMessage } from "./protocol-guards";

// ── Protocol Constants ────────────────────────────────────────

/**
 * Maximum number of frames that may sit in the reorder buffer at one time.
 * If this cap is breached (more than MAX_REORDER_BUFFER_SIZE frames ahead of
 * processedSeq), the gap is unlikely to self-resolve and a reconnect is safer
 * than growing the buffer indefinitely.
 */
const MAX_REORDER_BUFFER_SIZE = 200;

/**
 * How long (ms) a sequence gap may remain open before the controller forces a
 * reconnect. A gap that has not closed after GAP_TIMEOUT_MS is treated as a
 * permanent packet loss: the server retransmit window has expired, and the
 * only recovery path is RESUME from the last successfully processed sequence.
 */
const GAP_TIMEOUT_MS = 2000;

/**
 * Named constant for the TOOL_ACK settlement delay.
 * Gives buffered TOOL_RESULT frames time to surface in JS before ACK is sent,
 * addressing the replay race identified in DECISIONS.md.
 */
const TOOL_ACK_DELAY_MS = 50;

export class AgentWebSocketController {
  private ws: WebSocket | null = null;
  private readonly url: string;

  // ── Canonical Protocol State ────────────────────────────────
  private connectionState: ConnectionState = "DISCONNECTED";
  private processedSeq: number = 0;
  private eventLog: ServerMessage[] = [];
  private reorderBuffer: Map<number, ServerMessage> = new Map();
  private toolCallRegistry: Map<string, ToolCallStatus> = new Map();
  private pendingToolCallIds: Set<string> = new Set();
  private streamState: StreamState = "idle";

  // ── Gap Recovery State ───────────────────────────────────────
  /** Timer that fires when a sequence gap has been open for too long. */
  private gapTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Reconnection Backoff State ──────────────────────────────
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number = 500;
  private readonly maxBackoffMs: number = 10000;
  private isManualClose: boolean = false;

  // ── Subscriptions ───────────────────────────────────────────
  private onStateChange: (state: ConnectionState) => void;
  private onEventLogChange: (events: ServerMessage[]) => void;
  private onEventProcessed?: (msg: ServerMessage) => void;
  private onReset?: () => void;

  constructor(
    url: string,
    onStateChange: (state: ConnectionState) => void,
    onEventLogChange: (events: ServerMessage[]) => void,
    onEventProcessed?: (msg: ServerMessage) => void,
    onReset?: () => void
  ) {
    this.url = url;
    this.onStateChange = onStateChange;
    this.onEventLogChange = onEventLogChange;
    this.onEventProcessed = onEventProcessed;
    this.onReset = onReset;
  }

  // ── Connection Management ───────────────────────────────────

  public connect(): void {
    if (this.connectionState === "CONNECTED" || this.connectionState === "CONNECTING" || this.connectionState === "RESUMING") {
      return;
    }

    this.isManualClose = false;
    this.setConnectionState(this.processedSeq > 0 ? "RECONNECTING" : "CONNECTING");
    this.reorderBuffer.clear(); // Ensure clean slate for sequence processing on new sockets

    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onclose = () => this.handleClose();
      this.ws.onerror = (err) => this.handleError(err);
    } catch (error) {
      console.warn("[ws-controller] Connection error:", error);
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.isManualClose = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConnectionState("DISCONNECTED");
  }

  public sendUserMessage(content: string): void {
    if (this.connectionState !== "CONNECTED" || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.connectionState === "CONNECTED") {
        this.handleClose();
      }
      throw new Error("Cannot send message: WebSocket is not connected.");
    }

    // Reset sequence tracking, registries, and buffers for a new conversation turn
    this.processedSeq = 0;
    this.eventLog = [];
    this.reorderBuffer.clear();
    this.clearGapTimeout();
    this.toolCallRegistry.clear();
    this.pendingToolCallIds.clear();
    this.streamState = "idle";
    this.emitEventLog();
    if (this.onReset) this.onReset();

    const payload: ClientMessage = {
      type: "USER_MESSAGE",
      content,
    };
    this.safeSend(payload);
  }

  // ── Protocol Handlers ────────────────────────────────────────

  private handleOpen(): void {
    console.log("[ws-controller] Socket opened");
    this.backoffMs = 500; // Reset backoff on success

    if (this.processedSeq > 0) {
      // Reconnecting -> send RESUME first
      this.setConnectionState("RESUMING");
      console.log(`[ws-controller] Sending RESUME with last_seq=${this.processedSeq}`);
      const resumePayload: ClientMessage = {
        type: "RESUME",
        last_seq: this.processedSeq,
      };
      this.safeSend(resumePayload);
      
      // Clear out-of-order buffer upon reconnect. Since server will replay all
      // events with seq > processedSeq, keeping the out-of-order buffer is obsolete
      // and could cause state duplication/conflicts.
      this.reorderBuffer.clear();

      // Transition to CONNECTED immediately, replayed items will catch us up
      this.setConnectionState("CONNECTED");
    } else {
      // Fresh connection
      this.setConnectionState("CONNECTED");
    }
  }

  private handleMessage(event: MessageEvent): void {
    let rawMsg: ServerMessage;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isServerMessage(parsed)) {
        // Frame is valid JSON but does not match any known ServerMessage shape.
        // Log and discard — do not pass unvalidated data into protocol logic.
        console.warn(
          "[ws-controller] Rejected malformed frame (failed schema validation):",
          parsed
        );
        return;
      }
      rawMsg = parsed;
    } catch (err) {
      console.warn("[ws-controller] JSON parse error:", err, event.data);
      return;
    }

    // 1. Immediate Heartbeat Response (PING/PONG) Out-of-Band
    // Heartbeats must be handled immediately to meet the 3s timeout, even if there is a gap.
    if (rawMsg.type === "PING") {
      const pongPayload: ClientMessage = {
        type: "PONG",
        echo: rawMsg.challenge,
      };
      this.safeSend(pongPayload);
      console.log(`[ws-controller] Sent PONG for challenge: "${rawMsg.challenge}"`);
    }

    // 2. Deduplication Filter
    if (rawMsg.seq <= this.processedSeq) {
      console.log(`[ws-controller] Deduplicating message seq=${rawMsg.seq} (processed=${this.processedSeq})`);
      return;
    }

    // 3. Sliding-Window Sequence Reordering
    const nextExpectedSeq = this.processedSeq + 1;
    if (rawMsg.seq === nextExpectedSeq) {
      this.clearGapTimeout();
      this.processContiguousMessage(rawMsg);
      this.flushReorderBuffer();

      // If items remain in the buffer, a new gap has been established.
      // Re-initialize a gap timeout timer for the remaining gap.
      if (this.reorderBuffer.size > 0 && !this.gapTimeoutTimer) {
        this.gapTimeoutTimer = setTimeout(() => {
          console.warn(
            `[ws-controller] Sequence gap unresolved after ${GAP_TIMEOUT_MS}ms. ` +
            "Forcing reconnect to recover via RESUME."
          );
          this.reorderBuffer.clear();
          this.handleClose();
        }, GAP_TIMEOUT_MS);
      }
    } else if (rawMsg.seq > nextExpectedSeq) {
      console.log(
        `[ws-controller] Sequence gap detected. Expected=${nextExpectedSeq}, got=${rawMsg.seq}. Buffering.`
      );

      // ── Buffer size cap ──────────────────────────────────────
      // If the buffer exceeds the cap, the gap is almost certainly permanent.
      // Trigger a reconnect rather than growing memory indefinitely.
      this.reorderBuffer.set(rawMsg.seq, rawMsg);
      if (this.reorderBuffer.size > MAX_REORDER_BUFFER_SIZE) {
        console.warn(
          `[ws-controller] Reorder buffer cap (${MAX_REORDER_BUFFER_SIZE}) exceeded. ` +
          "Permanent gap assumed — forcing reconnect."
        );
        this.clearGapTimeout();
        this.reorderBuffer.clear();
        this.handleClose();
        return;
      }

      // ── Gap timeout ──────────────────────────────────────────
      // If the gap has not closed after GAP_TIMEOUT_MS, assume permanent loss.
      if (!this.gapTimeoutTimer) {
        this.gapTimeoutTimer = setTimeout(() => {
          console.warn(
            `[ws-controller] Sequence gap unresolved after ${GAP_TIMEOUT_MS}ms. ` +
            "Forcing reconnect to recover via RESUME."
          );
          this.reorderBuffer.clear();
          this.handleClose();
        }, GAP_TIMEOUT_MS);
      }
    }
  }

  private processContiguousMessage(msg: ServerMessage): void {
    // Deduplication check inside in case we flushed items that are somehow duplicated
    if (msg.seq <= this.processedSeq) {
      return;
    }

    // Update state machines based on message type
    switch (msg.type) {
      case "TOKEN":
        if (this.streamState === "idle") {
          this.streamState = "streaming";
        }
        break;

      case "TOOL_CALL": {
        // TOOL_ACK Replay Race Mitigation:
        // Before dispatching TOOL_ACK, scan the reorder buffer and registry to check
        // if the corresponding TOOL_RESULT is already present.
        const isResultAlreadyKnown = this.isToolResultAvailable(msg.call_id);

        if (isResultAlreadyKnown) {
          console.log(`[ws-controller] Bypassing TOOL_ACK for call_id="${msg.call_id}" since TOOL_RESULT is already buffered/known.`);
          this.toolCallRegistry.set(msg.call_id, "result_received");
        } else {
          this.toolCallRegistry.set(msg.call_id, "pending");
          // Schedule TOOL_ACK dispatch with a brief delay to allow
          // any replayed or rapid TOOL_RESULT frames to arrive and update the registry.
          // See DECISIONS.md — ACK replay race mitigation.
          setTimeout(() => {
            const currentStatus = this.toolCallRegistry.get(msg.call_id);
            if (currentStatus === "result_received") {
              console.log(`[ws-controller] Suppressing scheduled TOOL_ACK for call_id="${msg.call_id}" since TOOL_RESULT arrived during delay.`);
              return;
            }

            const ackPayload: ClientMessage = {
              type: "TOOL_ACK",
              call_id: msg.call_id,
            };
            this.safeSend(ackPayload);
            this.toolCallRegistry.set(msg.call_id, "acknowledged");
            console.log(`[ws-controller] Dispatched delayed TOOL_ACK for call_id="${msg.call_id}"`);
          }, TOOL_ACK_DELAY_MS);
        }

        // Add to stream set
        this.pendingToolCallIds.add(msg.call_id);
        this.streamState = "paused_for_tool";
        break;
      }

      case "TOOL_RESULT":
        this.toolCallRegistry.set(msg.call_id, "result_received");
        this.pendingToolCallIds.delete(msg.call_id);
        if (this.pendingToolCallIds.size === 0) {
          this.streamState = "streaming";
        }
        break;

      case "STREAM_END":
        this.streamState = "completed";
        break;
        
      case "ERROR":
        console.warn(`[ws-controller] Server error: code=${msg.code}, msg=${msg.message}`);
        // Reset stream state so the UI is not left in a permanently frozen
        // "streaming" or "paused_for_tool" state after a server-side error.
        // The user can send a new message once the error is displayed.
        this.streamState = "idle";
        this.pendingToolCallIds.clear();
        break;
    }

    // Append to the canonical event log
    this.eventLog.push(msg);
    this.processedSeq = msg.seq;
    this.emitEventLog();
    if (this.onEventProcessed) {
      this.onEventProcessed(msg);
    }
  }

  private flushReorderBuffer(): void {
    while (this.reorderBuffer.has(this.processedSeq + 1)) {
      const nextMsg = this.reorderBuffer.get(this.processedSeq + 1)!;
      this.reorderBuffer.delete(this.processedSeq + 1);
      this.processContiguousMessage(nextMsg);
    }
  }

  /**
   * Helper to check if a TOOL_RESULT is already available in the reorder buffer
   * or the registry for a specific call_id.
   */
  private isToolResultAvailable(callId: string): boolean {
    if (this.toolCallRegistry.get(callId) === "result_received") {
      return true;
    }
    // Scan reorder buffer for a matching TOOL_RESULT
    for (const msg of this.reorderBuffer.values()) {
      if (msg.type === "TOOL_RESULT" && msg.call_id === callId) {
        return true;
      }
    }
    return false;
  }

  private handleClose(): void {
    if (this.ws === null && this.connectionState === "RECONNECTING") {
      return;
    }
    console.log("[ws-controller] Socket closed");
    this.clearGapTimeout();
    this.ws = null;
    if (!this.isManualClose) {
      this.setConnectionState("RECONNECTING");
      this.scheduleReconnect();
    } else {
      this.setConnectionState("DISCONNECTED");
    }
  }

  private clearGapTimeout(): void {
    if (this.gapTimeoutTimer) {
      clearTimeout(this.gapTimeoutTimer);
      this.gapTimeoutTimer = null;
    }
  }

  private handleError(err: Event): void {
    console.warn("[ws-controller] Socket error:", err);
    // on error, socket close will follow, which triggers reconnection
  }

  // ── Reconnection Logic ───────────────────────────────────────

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    console.log(`[ws-controller] Scheduling reconnect in ${this.backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      // Exponential backoff
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }, this.backoffMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Getters / Helpers ────────────────────────────────────────

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public getProcessedSeq(): number {
    return this.processedSeq;
  }

  public getEventLog(): ServerMessage[] {
    return [...this.eventLog];
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      this.onStateChange(state);
    }
  }

  private emitEventLog(): void {
    this.onEventLogChange([...this.eventLog]);
  }

  private safeSend(payload: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn("[ws-controller] Tried to send message but socket is not open:", payload);
    }
  }
}
