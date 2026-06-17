/**
 * protocol-guards.ts
 *
 * Runtime type guards for every ServerMessage variant.
 *
 * These guards are the ONLY point where untrusted network data is validated.
 * TypeScript's `as ServerMessage` assertion provides zero runtime safety —
 * these guards replace it.
 *
 * Design: keep guards strict. A frame missing a required field is rejected
 * (logged + dropped) rather than passed through with `undefined` values that
 * would silently corrupt downstream state.
 */

import type { ServerMessage } from "../types/protocol";

// ── Primitive helpers ──────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasString(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === "string";
}

function hasNumber(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === "number";
}

function hasStringOrNumber(obj: Record<string, unknown>, key: string): boolean {
  return hasString(obj, key) || hasNumber(obj, key);
}

// ── Per-type guards ────────────────────────────────────────────────────────

function isTokenMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "TOKEN" &&
    hasNumber(obj, "seq") &&
    hasString(obj, "text") &&
    hasString(obj, "stream_id")
  );
}

function isToolCallMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "TOOL_CALL" &&
    hasNumber(obj, "seq") &&
    hasString(obj, "call_id") &&
    hasString(obj, "tool_name") &&
    isObject(obj["args"]) &&
    hasString(obj, "stream_id")
  );
}

function isToolResultMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "TOOL_RESULT" &&
    hasNumber(obj, "seq") &&
    hasString(obj, "call_id") &&
    isObject(obj["result"]) &&
    hasString(obj, "stream_id")
  );
}

function isContextSnapshotMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "CONTEXT_SNAPSHOT" &&
    hasNumber(obj, "seq") &&
    hasString(obj, "context_id") &&
    isObject(obj["data"])
  );
}

function isPingMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "PING" &&
    hasNumber(obj, "seq") &&
    // challenge is defined as string in the protocol, but the chaos engine
    // can send an empty string — that is still a valid string.
    hasString(obj, "challenge")
  );
}

function isStreamEndMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "STREAM_END" &&
    hasNumber(obj, "seq") &&
    hasString(obj, "stream_id")
  );
}

function isErrorMessage(obj: Record<string, unknown>): boolean {
  return (
    obj["type"] === "ERROR" &&
    hasNumber(obj, "seq") &&
    hasStringOrNumber(obj, "code") &&
    hasString(obj, "message")
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Validates that `value` conforms to one of the known ServerMessage variants.
 * Returns `true` and narrows the type, or returns `false` for unknown/malformed frames.
 */
export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isObject(value)) return false;

  switch (value["type"]) {
    case "TOKEN":           return isTokenMessage(value);
    case "TOOL_CALL":       return isToolCallMessage(value);
    case "TOOL_RESULT":     return isToolResultMessage(value);
    case "CONTEXT_SNAPSHOT":return isContextSnapshotMessage(value);
    case "PING":            return isPingMessage(value);
    case "STREAM_END":      return isStreamEndMessage(value);
    case "ERROR":           return isErrorMessage(value);
    default:                return false;
  }
}
