import type { OpenAIChatChunk, OpenAIUsage } from "./types";

export interface CompletedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface ToolBuffer {
  id: string;
  name: string;
  arguments: string;
}

export const MAX_SSE_LINE_CHARS = 1_048_576;
export const MAX_TOOL_ARGUMENT_CHARS = 262_144;
export const MAX_TOOL_CALLS = 128;
export const MAX_TOOL_METADATA_CHARS = 256;

export type StreamLimitKind = "line" | "tool_arguments" | "tool_calls" | "tool_metadata";

const STREAM_LIMIT_MESSAGES: Record<StreamLimitKind, string> = {
  line: "NaN Builders chat stream exceeded the maximum SSE line size.",
  tool_arguments: "NaN Builders chat stream exceeded the maximum tool argument size.",
  tool_calls: "NaN Builders chat stream exceeded the maximum number of tool calls.",
  tool_metadata: "NaN Builders chat stream exceeded the maximum tool metadata size.",
};

export class StreamLimitError extends Error {
  constructor(
    readonly kind: StreamLimitKind,
    readonly limit: number,
  ) {
    super(STREAM_LIMIT_MESSAGES[kind]);
    this.name = "StreamLimitError";
  }
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: CompletedToolCall }
  | { type: "usage"; usage: OpenAIUsage };

export class OpenAIStreamDecoder {
  private buffer = "";
  private readonly toolBuffers = new Map<number, ToolBuffer>();
  private emittedTools = false;
  private failure?: StreamLimitError;

  push(chunk: string): StreamEvent[] {
    this.throwIfFailed();
    const events: StreamEvent[] = [];
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== "\n") {
        continue;
      }
      const segment = chunk.slice(segmentStart, index);
      const trailingCarriageReturn = segment.endsWith("\r") || (!segment && this.buffer.endsWith("\r"));
      if (this.buffer.length + segment.length - (trailingCarriageReturn ? 1 : 0) > MAX_SSE_LINE_CHARS) {
        this.fail("line");
      }
      let line = this.buffer + segment;
      if (trailingCarriageReturn) {
        line = line.slice(0, -1);
      }
      this.buffer = "";
      events.push(...this.consumeLine(line));
      segmentStart = index + 1;
    }

    const remainder = chunk.slice(segmentStart);
    const trailingCarriageReturn = remainder.endsWith("\r") || (!remainder && this.buffer.endsWith("\r"));
    if (this.buffer.length + remainder.length - (trailingCarriageReturn ? 1 : 0) > MAX_SSE_LINE_CHARS) {
      this.fail("line");
    }
    this.buffer += remainder;
    return events;
  }

  finish(): StreamEvent[] {
    this.throwIfFailed();
    const events: StreamEvent[] = [];
    if (this.buffer.trim()) {
      events.push(...this.consumeLine(this.buffer));
    }
    this.buffer = "";
    events.push(...this.flushTools());
    return events;
  }

  private consumeLine(line: string): StreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) {
      return [];
    }
    if (!trimmed.startsWith("data:")) {
      return [];
    }

    const payload = trimmed.slice(5).trimStart();
    if (!payload) {
      return [];
    }
    if (payload === "[DONE]") {
      return this.flushTools();
    }

    let parsed: OpenAIChatChunk;
    try {
      parsed = JSON.parse(payload) as OpenAIChatChunk;
    } catch {
      return [];
    }

    const events: StreamEvent[] = [];
    const choice = parsed.choices?.[0];
    const delta = choice?.delta;

    if (typeof delta?.content === "string" && delta.content) {
      events.push({ type: "text", text: delta.content });
    }

    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      let current = this.toolBuffers.get(index);
      if (!current) {
        if (this.toolBuffers.size >= MAX_TOOL_CALLS) {
          this.fail("tool_calls");
        }
        current = { id: "", name: "", arguments: "" };
      }
      const id = typeof call.id === "string" ? call.id : "";
      const name = typeof call.function?.name === "string" ? call.function.name : "";
      const argumentsFragment =
        typeof call.function?.arguments === "string" ? call.function.arguments : "";
      if (id.length > MAX_TOOL_METADATA_CHARS || name.length > MAX_TOOL_METADATA_CHARS - current.name.length) {
        this.fail("tool_metadata");
      }
      if (argumentsFragment.length > MAX_TOOL_ARGUMENT_CHARS - current.arguments.length) {
        this.fail("tool_arguments");
      }
      if (id) {
        current.id = id;
      }
      if (name) {
        current.name += name;
      }
      if (argumentsFragment) {
        current.arguments += argumentsFragment;
      }
      this.toolBuffers.set(index, current);
    }

    if (choice?.finish_reason === "tool_calls") {
      events.push(...this.flushTools());
    }

    if (parsed.usage) {
      events.push({ type: "usage", usage: parsed.usage });
    }

    return events;
  }

  private flushTools(): StreamEvent[] {
    if (this.emittedTools || this.toolBuffers.size === 0) {
      return [];
    }
    this.emittedTools = true;

    const events: StreamEvent[] = [];
    const sorted = [...this.toolBuffers.entries()].sort(([a], [b]) => a - b);
    for (const [index, tool] of sorted) {
      const id = tool.id || `nan-tool-${index}`;
      const name = tool.name || "tool";
      let input: Record<string, unknown> = {};
      if (tool.arguments.trim()) {
        try {
          const parsed = JSON.parse(tool.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          } else {
            input = { value: parsed };
          }
        } catch {
          input = { __raw: tool.arguments };
        }
      }
      events.push({ type: "tool", tool: { id, name, input } });
    }
    return events;
  }

  private throwIfFailed(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  private fail(kind: StreamLimitKind): never {
    const limits = {
      line: MAX_SSE_LINE_CHARS,
      tool_arguments: MAX_TOOL_ARGUMENT_CHARS,
      tool_calls: MAX_TOOL_CALLS,
      tool_metadata: MAX_TOOL_METADATA_CHARS,
    } satisfies Record<StreamLimitKind, number>;
    const error = new StreamLimitError(kind, limits[kind]);
    this.buffer = "";
    this.toolBuffers.clear();
    this.failure = error;
    throw error;
  }
}
