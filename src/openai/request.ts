import { buildToolNameMappings, sanitizeSchema, sanitizeToolName } from "./tooling";
import type { OpenAIContentPart, OpenAIMessage, OpenAIToolDefinition } from "./types";

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

const REASONING_EFFORTS = /^(none|minimal|low|medium|high|max)$/;

export function reasoningEffort(options: { readonly [name: string]: unknown } | undefined): string {
  const requested = options?.reasoning_effort;
  return typeof requested === "string" && REASONING_EFFORTS.test(requested) ? requested : "low";
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function httpError(status: number, statusText: string, body: string): Error {
  const cleanBody = body.trim().slice(0, 500);
  const suffix = cleanBody ? `: ${cleanBody}` : "";
  return new Error(`NaN Builders API error ${status} ${statusText}${suffix}`);
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function isTextPart(value: unknown): value is { value: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { value?: unknown; callId?: unknown };
  return typeof candidate.value === "string" && typeof candidate.callId !== "string";
}

function isToolCallPart(value: unknown): value is { callId: string; name: string; input: unknown } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { callId?: unknown; name?: unknown };
  return typeof candidate.callId === "string" && typeof candidate.name === "string";
}

function isToolResultPart(value: unknown): value is { callId: string; content: readonly unknown[] } {
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
