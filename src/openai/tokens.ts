/**
 * Token-counting rules shared by the host-facing `provideTokenCount` and by
 * the history trimmer, so both budget with exactly the same numbers.
 *
 * The estimate is deliberately approximate. Text is counted at four characters
 * per token, the heuristic the competitor (`SrScorpio/nan-bridge`) and most
 * provider-side estimators use. Every part that carries image data costs a
 * flat 1024 tokens, matching the competitor's per-image value; OpenAI documents
 * `76 + area / 512` for gpt-4o, but that needs decoded dimensions, and a flat
 * per-image cost is predictable without them. Tool results are the exception:
 * the request builder sends them as one flattened string, so they are counted
 * from `flattenToolResult` to match the payload upstream.
 */
import type { OpenAIMessage } from "./types";

export const CHARS_PER_TOKEN = 4;

/** Flat cost of any message part that carries image data. */
export const IMAGE_TOKENS = 1024;

/** Unrecognized parts keep the previous fixed allowance: 64 characters / 4. */
const UNKNOWN_PART_TOKENS = 16;

/** Minimal message shape the counting rules understand. */
export interface CountableMessage {
  readonly content: readonly unknown[];
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Token count for one message's content parts. `provideTokenCount` returns
 * this value, so it is the host-side half of the shared estimator.
 */
export function countContentTokens(parts: readonly unknown[]): number {
  let tokens = 0;
  for (const part of parts) {
    tokens += countPartTokens(part);
  }
  return Math.max(1, tokens);
}

/**
 * Token count for a whole conversation. The history trimmer budgets with this
 * function, so it sees the same per-part numbers the host was told about.
 */
export function estimateHistoryTokens(messages: readonly CountableMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += countContentTokens(message.content);
  }
  return tokens;
}

/**
 * Token count for one already-converted OpenAI message. The history trimmer
 * budgets with this function, so the estimate it trims against is the same one
 * `provideTokenCount` reports: text at four characters per token, a flat
 * per-image cost, and tool calls charged for the name plus serialized
 * arguments exactly as the request builder sends them.
 */
export function countOpenAIMessageTokens(message: OpenAIMessage): number {
  let tokens = 0;
  const content = message.content;
  if (typeof content === "string") {
    tokens += estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      tokens += part.type === "image_url" ? IMAGE_TOKENS : estimateTokens(part.text);
    }
  }
  for (const call of message.tool_calls ?? []) {
    tokens += estimateTokens(`${call.function.name}${call.function.arguments}`);
  }
  return Math.max(1, tokens);
}

/** Token count for a converted conversation, message by message. */
export function countOpenAIMessagesTokens(messages: readonly OpenAIMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += countOpenAIMessageTokens(message);
  }
  return tokens;
}

function countPartTokens(part: unknown): number {
  if (isImagePart(part)) {
    return IMAGE_TOKENS;
  }
  if (isToolCallPart(part)) {
    return estimateTokens(`${part.name}${safeStringify(part.input)}`);
  }
  if (isToolResultPart(part)) {
    // The request builder sends a tool result as one flattened string, so the
    // estimate charges for that string. Counting the parts individually would
    // charge IMAGE_TOKENS for an image whose bytes are serialized as text.
    return estimateTokens(flattenToolResult(part.content));
  }
  if (isTextPart(part)) {
    return estimateTokens(part.value);
  }
  if (typeof part === "string") {
    return estimateTokens(part);
  }
  return UNKNOWN_PART_TOKENS;
}

/**
 * Serializes tool arguments exactly the way the request builder does, so the
 * tool-call estimate charges for the characters actually sent upstream.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Flattens one tool result into the single string the request builder sends as
 * the `tool` message content. String and text parts pass through; every other
 * part is JSON-serialized, so an image part contributes its serialized form
 * rather than image content. Counting reuses this function so the estimate and
 * the upstream payload always describe the same representation.
 */
export function flattenToolResult(content: readonly unknown[]): string {
  const pieces: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      pieces.push(part);
    } else if (isTextPart(part)) {
      pieces.push(part.value);
    } else {
      pieces.push(safeStringify(part));
    }
  }
  return pieces.join("");
}

export function isTextPart(value: unknown): value is { value: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { value?: unknown; callId?: unknown };
  return typeof candidate.value === "string" && typeof candidate.callId !== "string";
}

export function isToolCallPart(value: unknown): value is { callId: string; name: string; input: unknown } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { callId?: unknown; name?: unknown };
  return typeof candidate.callId === "string" && typeof candidate.name === "string";
}

export function isToolResultPart(value: unknown): value is { callId: string; content: readonly unknown[] } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { callId?: unknown; content?: unknown };
  return typeof candidate.callId === "string" && Array.isArray(candidate.content);
}

export function isImagePart(value: unknown): value is { data: Uint8Array; mimeType: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { data?: unknown; mimeType?: unknown };
  return (
    candidate.data instanceof Uint8Array &&
    typeof candidate.mimeType === "string" &&
    candidate.mimeType.startsWith("image/")
  );
}
