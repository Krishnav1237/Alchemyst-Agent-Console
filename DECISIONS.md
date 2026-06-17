# Architectural Decisions & Systems Review

This document highlights the design trade-offs, algorithms, and core engineering decisions implemented in the Agent Operations Console.

---

## 1. Sequence-Based Ordering & Deduplication
To handle out-of-order delivery, latency spikes, and duplicate messages in chaos mode, we treat sequence processing as a TCP-like sliding window:
* **Canonical State Pointer**: We maintain `processedSeq` (initialized to `0`).
* **Deduplication Filter**: Any incoming message with `seq <= processedSeq` is discarded immediately.
* **Reordering Map**: We use a sparse `Map<number, ServerMessage>` as our buffer. A hash map provides $O(1)$ lookup and insertions.
* **Resolution Loop**: When a message with `seq === processedSeq + 1` is received:
  1. We process and apply it to our projections.
  2. We increment `processedSeq` to `seq`.
  3. We check if `processedSeq + 1` exists in our `reorderBuffer` map.
  4. If it does, we delete it from the buffer, process it, increment `processedSeq`, and repeat.
  5. If it does not, we stop and wait for the gap to be resolved.

This design guarantees that no event is processed out of sequence and that duplicates never leak into state projections.

---

## 2. Preventing Layout Shift & Jitter
Naive text streaming appends tokens directly to a single message string, causing text wrapping recalculations and layout jumps when a tool card is dynamically inserted mid-stream. We solve this through structural and style boundaries:
* **Block-Based Projection**: The Dialogue is split into independent rendering blocks:
  * `TextBlock`: A contiguous chunk of text.
  * `ToolCallBlock`: A block displaying tool args and results.
* **Freezing Boundary**: When a `TOOL_CALL` is received, the current `TextBlock` is marked as `isFrozen: true`. Subsequent tokens are appended to a *new* `TextBlock` created below the tool block.
* **CSS Containment**:
  * We apply `contain: layout;` to parent containers, isolating DOM tree layout calculations.
  * Text blocks use `word-break: break-word; white-space: pre-wrap;` to keep line wraps predictable.
  * Tool cards are styled with an explicit `min-height: 70px` and flexible margins, avoiding height jumps when the server's delayed execution results populate.

---

## 3. Reconnection State Recovery
Tracking state recovery requires separating what the *network socket* has received from what the *DOM state* has successfully processed:
* **Canonical Registry Pointer**: The `processedSeq` variable is only advanced *after* the event is contiguously resolved and applied to the React state. It reflects the exact sequence of the DOM's state.
* **Disposable Buffer**: Upon starting a new connection attempt or establishing a socket handshake, we call `reorderBuffer.clear()` to ensure stale, pre-disconnect out-of-order events from a failed link do not persist or corrupt the sequence state. When we send `RESUME { last_seq: processedSeq }` upon reconnect, the server is guaranteed to replay all events where `seq > processedSeq` in correct chronological order. Storing pre-disconnect out-of-order events is redundant and could cause key collisions.
* **Turn Reset Protections**: `sendUserMessage()` clears the gap timeout timer to ensure any unresolved sequence gaps from a prior turn do not leak into the new context and force spurious reconnects.
* **Input Lock**: The input bar is disabled during `RESUMING` to prevent users from sending new commands while replayed logs are processing, preventing transaction races.

---

## 4. Known Protocol Limitations & Correctness
During review of the agent-server protocol, key architectural specifications were identified as under-specified. Correctness was achieved by designing the client around transport invariants rather than heuristic boundaries:

* **Turn Ambiguity due to Sequence Reuse**: The server resets sequence numbers (`this.seq = 0`) per turn without carrying a `turn_id` or session generation epoch in the frames. Stale in-flight frames can therefore pollute the client reorder buffer upon turn resets. The client mitigates this by UI input locks and buffer flushes upon user submission, but a robust fix requires a protocol-level generation identifier.
* **Unobservable Replay Completion**: The server does not send a `REPLAY_END` or `HIGH_WATERMARK` frame. Replay catch-up completion is mathematically unknowable.
* **Invariant-Based Correctness**: Because of these protocol limitations, client correctness (sequence reordering, duplicate filtering, tool ACK suppression) is designed around strict protocol invariants rather than relying on detecting a replay-boundary or turn transitions. The client remains stable and correct even if the UI lock is disabled.

---

## 5. Scalability: 50 Concurrent Agent Streams
If this application scaled to a dashboard managing 50 concurrent agent streams:
1. **Off-Thread JSON Diffing**: Deep-diffing 50 concurrent streams of 500KB context snapshots would block the main thread. We would move the diff calculations to **Web Workers**, communicating diff results via postMessage.
2. **State Throttling & Batching**: Rather than updating React state on every token, we would queue updates in the WebSocket controller and batch them (e.g., every 100ms) before committing to the React store, reducing render cycles.
3. **Canvas / WebGL Timeline**: For massive timeline throughput, rendering DOM nodes would choke the browser. We would replace the HTML list with a virtualized list, or draw the logs onto an HTML5 `<canvas>` using WebGL.

---

## 6. Scalability: 100x Longer Responses (Document Generation)
If responses were 100x longer (full document generation):
1. **Incremental DOM Chunking**: Instead of holding the entire text document in a single React state array, we would split the document into pages or sections. Sections out of the viewport would be unmounted (virtualized) using `content-visibility: auto;`.
2. **Event Compaction & Snapshotting**: An event log of 100,000+ items would consume gigabytes of memory. We would implement **compaction**: once a stream completes, its tokens are squashed into a single static document state, and the intermediate `TOKEN` events are deleted from memory.
3. **Lazy JSON Scrubber**: The context inspector history would only keep a sliding window of the last 5 snapshots in memory, storing older history on the server and fetching them on-demand if the user moves the scrubber slider back.
