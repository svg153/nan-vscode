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

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: CompletedToolCall }
  | { type: "usage"; usage: OpenAIUsage };

export class OpenAIStreamDecoder {
  private buffer = "";
  private readonly toolBuffers = new Map<number, ToolBuffer>();
  private emittedTools = false;

  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";

    const events: StreamEvent[] = [];
    for (const line of lines) {
      events.push(...this.consumeLine(line));
    }
    return events;
  }

  finish(): StreamEvent[] {
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
      const current = this.toolBuffers.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) {
        current.id = call.id;
      }
      if (call.function?.name) {
        current.name += call.function.name;
      }
      if (call.function?.arguments) {
        current.arguments += call.function.arguments;
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
}
