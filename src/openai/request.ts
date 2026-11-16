import { buildToolNameMappings, sanitizeSchema, sanitizeToolName } from "./tooling";
import type { OpenAIContentPart, OpenAIMessage, OpenAIToolDefinition } from "./types";
import { isImagePart, isTextPart, isToolCallPart, isToolResultPart, safeStringify } from "./tokens";
import { sanitizeUpstreamText } from "../text";

export { estimateTokens, isImagePart } from "./tokens";

export interface ToolMapping {
  readonly definitions: OpenAIToolDefinition[];
  readonly sanitizedToOriginal: ReadonlyMap<string, string>;
  readonly originalToSanitized: ReadonlyMap<string, string>;
  readonly toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } };
}

/**
 * A chat message reduced to plain data so request building stays testable
 * without importing the `vscode` module.
 */
export interface PlainMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly unknown[];
}

export interface PlainTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export function httpError(status: number, statusText: string, body: string): Error {
  const summary = sanitizeErrorBody(body);
  const suffix = summary ? `: ${summary}` : "";
  const hint = status === 402 ? ` — ${CREDITS_REFUSED_HINT}` : "";
  return new Error(
    `NaN Builders API error ${status} ${sanitizeUpstreamText(statusText, MAX_FIELD_LENGTH)}${suffix}${hint}`,
  );
}

/**
 * HTTP 402 is the only symptom of an exhausted or frozen credit pool, so the
 * message names the three causes the user can act on instead of staying cryptic.
 */
const CREDITS_REFUSED_HINT =
  "NaN Builders bills every metered model from one credits pool, so this request was refused because the " +
  "plan allowance is spent, credits are frozen, or no credit pack is active. Run 'NaN Builders: Show Usage' " +
  "for the balance, or use a model that does not draw credits.";

const MAX_SUMMARY_LENGTH = 200;
const MAX_FIELD_LENGTH = 64;

/**
 * Upstream bodies can echo the request, including user prompt text and API
 * keys. Only structural error identifiers are surfaced; free-form messages are
 * dropped entirely.
 */
export function sanitizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  const summary = summarizeError(trimmed);
  return summary ? redactSecrets(summary).slice(0, MAX_SUMMARY_LENGTH) : "";
}

function summarizeError(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return "";
  }
  const fields = error as { type?: unknown; code?: unknown; param?: unknown };
  const parts: string[] = [];
  for (const value of [fields.type, fields.code, fields.param]) {
    if (typeof value === "string" && value.trim()) {
      parts.push(value.trim().slice(0, MAX_FIELD_LENGTH));
    }
  }
  return parts.join(" ");
}

function redactSecrets(text: string): string {
  return sanitizeUpstreamText(text, MAX_SUMMARY_LENGTH);
}

export function convertMessages(
  messages: readonly PlainMessage[],
  originalToSanitized: ReadonlyMap<string, string>,
): OpenAIMessage[] {
  const converted: OpenAIMessage[] = [];

  for (const message of messages) {
    const textParts: OpenAIContentPart[] = [];
    const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (isImagePart(part)) {
        textParts.push({
          type: "image_url",
          image_url: {
            url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`,
          },
        });
      } else if (isToolCallPart(part)) {
        toolCalls.push({
          id: part.callId,
          type: "function",
          function: {
            name: originalToSanitized.get(part.name) ?? sanitizeToolName(part.name),
            arguments: safeStringify(part.input),
          },
        });
      } else if (isToolResultPart(part)) {
        toolResults.push({
          callId: part.callId,
          content: flattenToolResult(part.content),
        });
      } else if (isTextPart(part)) {
        textParts.push({ type: "text", text: part.value });
      }
    }

    if (toolCalls.length > 0) {
      converted.push({
        role: "assistant",
        content: textParts.length ? contentValue(textParts) : null,
        tool_calls: toolCalls,
      });
    }

    for (const result of toolResults) {
      converted.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.content,
      });
    }

    if (toolCalls.length === 0 && textParts.length > 0) {
      converted.push({
        role: message.role,
        content: contentValue(textParts),
      });
    }
  }

  return converted;
}

export function convertTools(tools: readonly PlainTool[], required: boolean): ToolMapping {
  const { originalToSanitized, sanitizedToOriginal } = buildToolNameMappings(tools.map((tool) => tool.name));
  const definitions: OpenAIToolDefinition[] = [];

  for (const tool of tools) {
    const sanitized = originalToSanitized.get(tool.name) ?? sanitizeToolName(tool.name);
    definitions.push({
      type: "function",
      function: {
        name: sanitized,
        description: tool.description,
        parameters: sanitizeSchema(tool.inputSchema),
      },
    });
  }

  let toolChoice: ToolMapping["toolChoice"];
  if (definitions.length > 0) {
    toolChoice = "auto";
  }
  if (required) {
    toolChoice = "required";
  }

  return { definitions, sanitizedToOriginal, originalToSanitized, toolChoice };
}

function contentValue(parts: OpenAIContentPart[]): string | OpenAIContentPart[] {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return parts;
}

function flattenToolResult(content: readonly unknown[]): string {
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
