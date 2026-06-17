/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentWebSocketController } from "../lib/ws-controller";
import { ServerMessage, ClientMessage } from "../types/protocol";
import { isServerMessage } from "../lib/protocol-guards";

// Mock global WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  public url: string;
  public onopen: (() => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((err: Event) => void) | null = null;
  public readyState: number = 0; // CONNECTING
  public sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.activeInstance = this;
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen();
    }, 5);
  }

  static activeInstance: MockWebSocket | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  simulateMessage(msg: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(msg) } as MessageEvent);
    }
  }
}

describe("AgentWebSocketController - Sequence Ordering & Protocols", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    MockWebSocket.activeInstance = null;
  });

  it("should initialize in DISCONNECTED state", () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    expect(controller.getConnectionState()).toBe("DISCONNECTED");
  });

  it("should process sequential messages and advance processedSeq", async () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    controller.connect();
    await vi.advanceTimersByTimeAsync(10); // Let WebSocket open
    
    // Send user message to initialize sequence starting at 1
    controller.sendUserMessage("Hello");
    const ws = MockWebSocket.activeInstance!;
    
    // Server streams seq 1 and seq 2
    ws.simulateMessage({ type: "TOKEN", seq: 1, text: "Hello", stream_id: "s1" } as ServerMessage);
    ws.simulateMessage({ type: "TOKEN", seq: 2, text: " world", stream_id: "s1" } as ServerMessage);

    expect(controller.getProcessedSeq()).toBe(2);
    expect(controller.getEventLog().length).toBe(2);
    expect(controller.getEventLog()[0].type).toBe("TOKEN");
    expect(controller.getEventLog()[1].type).toBe("TOKEN");
  });

  it("should buffer out-of-order messages and flush when gap is resolved", async () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    controller.connect();
    await vi.advanceTimersByTimeAsync(10);
    controller.sendUserMessage("Hello");
    const ws = MockWebSocket.activeInstance!;

    // Send seq 3 first (out of order gap)
    ws.simulateMessage({ type: "TOKEN", seq: 3, text: "!", stream_id: "s1" } as ServerMessage);
    expect(controller.getProcessedSeq()).toBe(0); // Gap holds it
    expect(controller.getEventLog().length).toBe(0);

    // Send seq 1
    ws.simulateMessage({ type: "TOKEN", seq: 1, text: "Hello", stream_id: "s1" } as ServerMessage);
    expect(controller.getProcessedSeq()).toBe(1);
    expect(controller.getEventLog().length).toBe(1);

    // Send seq 2
    ws.simulateMessage({ type: "TOKEN", seq: 2, text: " world", stream_id: "s1" } as ServerMessage);
    // Sequence is fully contigous now -> should flush 2 and 3
    expect(controller.getProcessedSeq()).toBe(3);
    expect(controller.getEventLog().length).toBe(3);
    expect(controller.getEventLog()[2].seq).toBe(3);
  });

  it("should deduplicate already processed messages", async () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    controller.connect();
    await vi.advanceTimersByTimeAsync(10);
    controller.sendUserMessage("Hello");
    const ws = MockWebSocket.activeInstance!;

    ws.simulateMessage({ type: "TOKEN", seq: 1, text: "Hello", stream_id: "s1" } as ServerMessage);
    ws.simulateMessage({ type: "TOKEN", seq: 1, text: "Hello", stream_id: "s1" } as ServerMessage); // Duplicate

    expect(controller.getProcessedSeq()).toBe(1);
    expect(controller.getEventLog().length).toBe(1);
  });

  it("should respond to PING immediately out-of-band", async () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    controller.connect();
    await vi.advanceTimersByTimeAsync(10);
    controller.sendUserMessage("Hello");
    const ws = MockWebSocket.activeInstance!;

    // Send out-of-order PING (seq 10) while processedSeq is 0
    ws.simulateMessage({ type: "PING", seq: 10, challenge: "ping_echo" } as ServerMessage);

    // Verify PONG was sent immediately
    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]) as ClientMessage;
    expect(lastSent.type).toBe("PONG");
    expect((lastSent as { echo: string }).echo).toBe("ping_echo");

    // Reordering is intact: PING is in buffer but processedSeq did not advance because of gap
    expect(controller.getProcessedSeq()).toBe(0);
  });

  it("should suppress TOOL_ACK when TOOL_RESULT is already in reorder queue", async () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    controller.connect();
    await vi.advanceTimersByTimeAsync(10);
    controller.sendUserMessage("Hello");
    const ws = MockWebSocket.activeInstance!;

    // Server sends TOOL_RESULT (seq 2) out of order before TOOL_CALL (seq 1)
    ws.simulateMessage({ type: "TOOL_RESULT", seq: 2, call_id: "tc_suppress", result: { ok: true }, stream_id: "s1" } as ServerMessage);
    
    // Clear sent log to only track subsequent client dispatches
    ws.sent = [];

    // Server sends TOOL_CALL (seq 1) - this is contiguous, so it will process immediately and check the reorder buffer for seq 2
    ws.simulateMessage({ type: "TOOL_CALL", seq: 1, call_id: "tc_suppress", tool_name: "test_tool", args: {}, stream_id: "s1" } as ServerMessage);

    // Let the 50ms delay for TOOL_ACK scheduler fire
    await vi.advanceTimersByTimeAsync(50);

    // Verify TOOL_ACK was suppressed (ws.sent should not contain a TOOL_ACK for tc_suppress)
    const hasAck = ws.sent.some(msg => {
      const parsed = JSON.parse(msg) as ClientMessage;
      return parsed.type === "TOOL_ACK" && parsed.call_id === "tc_suppress";
    });
    expect(hasAck).toBe(false);

    // If a fresh tool call arrives without result (seq 3), it should ACK
    ws.simulateMessage({ type: "TOOL_CALL", seq: 3, call_id: "tc_ack", tool_name: "test_tool", args: {}, stream_id: "s1" } as ServerMessage);
    
    // Let the 50ms delay for TOOL_ACK scheduler fire
    await vi.advanceTimersByTimeAsync(50);
    
    const hasAckFresh = ws.sent.some(msg => {
      const parsed = JSON.parse(msg) as ClientMessage;
      return parsed.type === "TOOL_ACK" && parsed.call_id === "tc_ack";
    });
    expect(hasAckFresh).toBe(true);
  });

  it("should transmit RESUME with last processed seq upon reconnect", async () => {
    const onStateChange = vi.fn();
    const onEventLogChange = vi.fn();
    const controller = new AgentWebSocketController("ws://localhost:4747/ws", onStateChange, onEventLogChange);

    controller.connect();
    await vi.advanceTimersByTimeAsync(10);
    controller.sendUserMessage("Hello");
    const ws1 = MockWebSocket.activeInstance!;

    ws1.simulateMessage({ type: "TOKEN", seq: 1, text: "A", stream_id: "s1" } as ServerMessage);
    ws1.simulateMessage({ type: "TOKEN", seq: 2, text: "B", stream_id: "s1" } as ServerMessage);
    
    expect(controller.getProcessedSeq()).toBe(2);

    // Simulate connection drop
    ws1.close();
    expect(controller.getConnectionState()).toBe("RECONNECTING");

    // Advance timer to trigger reconnect connect()
    await vi.advanceTimersByTimeAsync(500); // Backoff starts at 500ms
    const ws2 = MockWebSocket.activeInstance!;
    await vi.advanceTimersByTimeAsync(10); // Let it open

    // Verify first message sent is RESUME with seq 2
    const firstMessage = JSON.parse(ws2.sent[0]) as ClientMessage;
    expect(firstMessage.type).toBe("RESUME");
    expect((firstMessage as { last_seq: number }).last_seq).toBe(2);
  });

  describe("Fix 1: Runtime Validation & Type Guards", () => {
    it("should correctly validate valid ServerMessages", () => {
      const validToken = { type: "TOKEN", seq: 1, text: "hi", stream_id: "s1" };
      const validToolCall = { type: "TOOL_CALL", seq: 2, call_id: "c1", tool_name: "t1", args: {}, stream_id: "s1" };
      const validToolResult = { type: "TOOL_RESULT", seq: 3, call_id: "c1", result: { ok: true }, stream_id: "s1" };
      const validSnapshot = { type: "CONTEXT_SNAPSHOT", seq: 4, context_id: "ctx1", data: {} };
      const validPing = { type: "PING", seq: 5, challenge: "ping_echo" };
      const validStreamEnd = { type: "STREAM_END", seq: 6, stream_id: "s1" };
      const validError = { type: "ERROR", seq: 7, code: "ERR", message: "fail" };

      expect(isServerMessage(validToken)).toBe(true);
      expect(isServerMessage(validToolCall)).toBe(true);
      expect(isServerMessage(validToolResult)).toBe(true);
      expect(isServerMessage(validSnapshot)).toBe(true);
      expect(isServerMessage(validPing)).toBe(true);
      expect(isServerMessage(validStreamEnd)).toBe(true);
      expect(isServerMessage(validError)).toBe(true);
    });

    it("should reject invalid/malformed ServerMessages", () => {
      expect(isServerMessage(null)).toBe(false);
      expect(isServerMessage(undefined)).toBe(false);
      expect(isServerMessage("not an object")).toBe(false);
      expect(isServerMessage([])).toBe(false);
      expect(isServerMessage({ type: "UNKNOWN" })).toBe(false);
      
      // Missing fields
      expect(isServerMessage({ type: "TOKEN", seq: 1, text: "hi" })).toBe(false); // missing stream_id
      expect(isServerMessage({ type: "TOOL_CALL", seq: 2, call_id: "c1", tool_name: "t1" })).toBe(false); // missing args/stream_id
      expect(isServerMessage({ type: "ERROR", seq: 3, code: "ERR" })).toBe(false); // missing message
      
      // Wrong types
      expect(isServerMessage({ type: "PING", seq: "5", challenge: "ping_echo" })).toBe(false); // seq is string
      expect(isServerMessage({ type: "TOKEN", seq: 1, text: 123, stream_id: "s1" })).toBe(false); // text is number
    });

    it("should discard malformed messages at socket boundary and not process/log them", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const onEventProcessed = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange,
        onEventProcessed
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Send malformed frames
      ws.simulateMessage({ type: "TOKEN", seq: 1 }); // missing stream_id/text
      ws.simulateMessage({ type: "UNKNOWN_TYPE", seq: 2 });
      
      expect(onEventProcessed).not.toHaveBeenCalled();
      expect(controller.getProcessedSeq()).toBe(0);
      expect(controller.getEventLog().length).toBe(0);
    });
  });

  describe("Fix 2: Reorder Buffer Cap & Gap Timeout", () => {
    it("should trigger reconnect when reorder buffer exceeds MAX_REORDER_BUFFER_SIZE (200)", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Populate reorder buffer with 201 items (seq 2 to 202) creating a gap (expected seq 1)
      for (let seq = 2; seq <= 202; seq++) {
        ws.simulateMessage({
          type: "TOKEN",
          seq,
          text: "chunk",
          stream_id: "s1",
        } as ServerMessage);
      }

      // Cap exceeded -> transitioned to RECONNECTING
      expect(controller.getConnectionState()).toBe("RECONNECTING");
      expect((controller as any).reorderBuffer.size).toBe(0);
    });

    it("should trigger reconnect when gap remains unresolved for GAP_TIMEOUT_MS (2000ms)", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Send seq 2 (gap since expected seq is 1)
      ws.simulateMessage({
        type: "TOKEN",
        seq: 2,
        text: "world",
        stream_id: "s1",
      } as ServerMessage);

      expect(controller.getConnectionState()).toBe("CONNECTED");

      // Advance 1999ms - should still be connected
      await vi.advanceTimersByTimeAsync(1999);
      expect(controller.getConnectionState()).toBe("CONNECTED");

      // Advance 2ms more (2001ms total) - should trigger reconnect
      await vi.advanceTimersByTimeAsync(2);
      expect(controller.getConnectionState()).toBe("RECONNECTING");
    });

    it("should clear gap timeout when gap is resolved before GAP_TIMEOUT_MS", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Send seq 2 (gap)
      ws.simulateMessage({
        type: "TOKEN",
        seq: 2,
        text: "world",
        stream_id: "s1",
      } as ServerMessage);

      // Advance 1000ms
      await vi.advanceTimersByTimeAsync(1000);

      // Resolve gap by sending seq 1
      ws.simulateMessage({
        type: "TOKEN",
        seq: 1,
        text: "Hello",
        stream_id: "s1",
      } as ServerMessage);

      expect(controller.getProcessedSeq()).toBe(2);

      // Advance another 1500ms (total 2500ms since gap opened)
      await vi.advanceTimersByTimeAsync(1500);

      // State should remain CONNECTED
      expect(controller.getConnectionState()).toBe("CONNECTED");
    });

    it("should prevent duplicate reconnect timers if multiple close triggers occur", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Trigger socket close first
      ws.close();
      expect(controller.getConnectionState()).toBe("RECONNECTING");

      // Trigger redundant handleClose directly (e.g. from buffer cap or gap timeout concurrent handler)
      (controller as any).handleClose();

      // Check that only a single reconnect is pending and hasn't fired yet at 499ms
      await vi.advanceTimersByTimeAsync(499);
      expect(controller.getConnectionState()).toBe("RECONNECTING");

      // Reconnect fires exactly at 500ms (backoff)
      await vi.advanceTimersByTimeAsync(2);
      const ws2 = MockWebSocket.activeInstance!;
      expect(ws2).not.toBe(ws);
    });

    it("should clear gap timeout when sendUserMessage is called for a new turn", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Send seq 2 (gap since expected seq is 1)
      ws.simulateMessage({
        type: "TOKEN",
        seq: 2,
        text: "world",
        stream_id: "s1",
      } as ServerMessage);

      // Verify timer exists
      expect((controller as any).gapTimeoutTimer).not.toBeNull();

      // Start new turn (sendUserMessage)
      controller.sendUserMessage("New Message");

      // Verify timer was cleared
      expect((controller as any).gapTimeoutTimer).toBeNull();
      
      // Advance by 2000ms - should not reconnect because timer is dead
      await vi.advanceTimersByTimeAsync(2000);
      expect(controller.getConnectionState()).toBe("CONNECTED");
    });

    it("should re-initialize gap timeout if a partial flush leaves remaining gaps in the buffer", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Send seq 2, 3, 5 (creates gap at 1, and gap at 4)
      ws.simulateMessage({ type: "TOKEN", seq: 2, text: "B", stream_id: "s1" } as ServerMessage);
      ws.simulateMessage({ type: "TOKEN", seq: 3, text: "C", stream_id: "s1" } as ServerMessage);
      ws.simulateMessage({ type: "TOKEN", seq: 5, text: "E", stream_id: "s1" } as ServerMessage);

      expect((controller as any).gapTimeoutTimer).not.toBeNull();

      // Resolve the first gap by sending seq 1
      ws.simulateMessage({ type: "TOKEN", seq: 1, text: "A", stream_id: "s1" } as ServerMessage);

      // This will flush 1, 2, 3. The reorder buffer still contains 5. Missing 4.
      expect(controller.getProcessedSeq()).toBe(3);
      expect((controller as any).reorderBuffer.size).toBe(1); // seq 5 is still there
      
      // The old gap timer should have been cleared, and a new gap timer should be initialized for the gap at 4
      expect((controller as any).gapTimeoutTimer).not.toBeNull();

      // Advance by 1999ms - should still be connected
      await vi.advanceTimersByTimeAsync(1999);
      expect(controller.getConnectionState()).toBe("CONNECTED");

      // Advance past 2000ms - should force reconnect due to the remaining gap at 4
      await vi.advanceTimersByTimeAsync(2);
      expect(controller.getConnectionState()).toBe("RECONNECTING");
    });
  });

  describe("Fix 3: ERROR -> Stream Recovery & Reconnect", () => {
    it("should reset streamState and pendingToolCallIds on ERROR message", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws = MockWebSocket.activeInstance!;

      // Simulate stream progress and a pending tool call
      ws.simulateMessage({
        type: "TOOL_CALL",
        seq: 1,
        call_id: "c1",
        tool_name: "get_weather",
        args: {},
        stream_id: "s1",
      } as ServerMessage);

      expect((controller as any).streamState).toBe("paused_for_tool");
      expect((controller as any).pendingToolCallIds.has("c1")).toBe(true);

      // Send ERROR message
      ws.simulateMessage({
        type: "ERROR",
        seq: 2,
        code: "INTERNAL_ERROR",
        message: "An internal server error occurred",
      } as ServerMessage);

      // Verify recovery
      expect((controller as any).streamState).toBe("idle");
      expect((controller as any).pendingToolCallIds.size).toBe(0);
    });

    it("should reconnect and recover via RESUME after gap timeout", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws1 = MockWebSocket.activeInstance!;

      // Successfully process seq 1
      ws1.simulateMessage({
        type: "TOKEN",
        seq: 1,
        text: "Hello",
        stream_id: "s1",
      } as ServerMessage);
      expect(controller.getProcessedSeq()).toBe(1);

      // Send seq 3 (gap)
      ws1.simulateMessage({
        type: "TOKEN",
        seq: 3,
        text: "!",
        stream_id: "s1",
      } as ServerMessage);
      expect(controller.getProcessedSeq()).toBe(1);

      // Wait 2000ms for gap timeout to close connection
      await vi.advanceTimersByTimeAsync(2000);
      expect(controller.getConnectionState()).toBe("RECONNECTING");

      // Wait 500ms for backoff reconnect
      await vi.advanceTimersByTimeAsync(500);
      const ws2 = MockWebSocket.activeInstance!;
      expect(ws2).not.toBe(ws1);

      // Open new connection
      await vi.advanceTimersByTimeAsync(10);

      // Verify it sent RESUME with last_seq = 1
      const lastMessage = JSON.parse(ws2.sent[0]) as ClientMessage;
      expect(lastMessage.type).toBe("RESUME");
      expect((lastMessage as any).last_seq).toBe(1);

      // Verify we can process the replayed sequence and continue
      ws2.simulateMessage({
        type: "TOKEN",
        seq: 2,
        text: " world",
        stream_id: "s1",
      } as ServerMessage);
      ws2.simulateMessage({
        type: "TOKEN",
        seq: 3,
        text: "!",
        stream_id: "s1",
      } as ServerMessage);

      expect(controller.getProcessedSeq()).toBe(3);
      expect(controller.getEventLog().length).toBe(3);
    });

    it("should suppress TOOL_ACK for a TOOL_CALL if the corresponding TOOL_RESULT arrives during the delay window after a reconnect", async () => {
      const onStateChange = vi.fn();
      const onEventLogChange = vi.fn();
      const controller = new AgentWebSocketController(
        "ws://localhost:4747/ws",
        onStateChange,
        onEventLogChange
      );

      controller.connect();
      await vi.advanceTimersByTimeAsync(10);
      controller.sendUserMessage("Hello");
      const ws1 = MockWebSocket.activeInstance!;

      // 1. Receive TOOL_RESULT out of order (seq 2) before TOOL_CALL (seq 1) -> buffered
      ws1.simulateMessage({
        type: "TOOL_RESULT",
        seq: 2,
        call_id: "c_recon_suppress",
        result: { value: 100 },
        stream_id: "s1",
      } as ServerMessage);

      // Connection drops before seq 1 arrives
      ws1.close();
      expect(controller.getConnectionState()).toBe("RECONNECTING");

      // Reconnect
      await vi.advanceTimersByTimeAsync(500);
      const ws2 = MockWebSocket.activeInstance!;
      await vi.advanceTimersByTimeAsync(10);

      // Reorder buffer is cleared on reconnect, processedSeq is still 0
      expect((controller as any).reorderBuffer.size).toBe(0);
      expect(controller.getProcessedSeq()).toBe(0);

      // Clear ws2 sent list
      ws2.sent = [];

      // 2. Server replays starting from seq 1. Sends TOOL_CALL (seq 1) first.
      ws2.simulateMessage({
        type: "TOOL_CALL",
        seq: 1,
        call_id: "c_recon_suppress",
        tool_name: "test_tool",
        args: {},
        stream_id: "s1",
      } as ServerMessage);

      // expected next was 1, processedSeq becomes 1.
      // Since result is not in registry or reorder buffer (both cleared/empty), it schedules a delayed TOOL_ACK.
      expect((controller as any).toolCallRegistry.get("c_recon_suppress")).toBe("pending");

      // 3. Immediately after, server sends replayed TOOL_RESULT (seq 2).
      ws2.simulateMessage({
        type: "TOOL_RESULT",
        seq: 2,
        call_id: "c_recon_suppress",
        result: { value: 100 },
        stream_id: "s1",
      } as ServerMessage);

      // Processed seq becomes 2. Registry updates to "result_received".
      expect((controller as any).toolCallRegistry.get("c_recon_suppress")).toBe("result_received");

      // 4. Let the 50ms delay fire.
      await vi.advanceTimersByTimeAsync(50);

      // Verify TOOL_ACK was suppressed
      const hasAck = ws2.sent.some(msg => {
        const parsed = JSON.parse(msg) as ClientMessage;
        return parsed.type === "TOOL_ACK" && parsed.call_id === "c_recon_suppress";
      });
      expect(hasAck).toBe(false);
    });
  });
});

