import { buildToolNameMappings, sanitizeSchema, sanitizeToolName } from "./tooling";
import type { OpenAIContentPart, OpenAIMessage, OpenAIToolDefinition } from "./types";
import {
  flattenToolResult,
  isImagePart,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
  safeStringify,
} from "./tokens";

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
