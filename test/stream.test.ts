import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIStreamDecoder } from "../src/openai/stream";

test("streams text across arbitrary network chunk boundaries", () => {
  const decoder = new OpenAIStreamDecoder();
  const events = [
    ...decoder.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n'),
    ...decoder.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DO'),
    ...decoder.push('NE]\n'),
    ...decoder.finish(),
  ];
  assert.deepEqual(
    events.filter((event) => event.type === "text"),
    [
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ],
  );
});

test("assembles streamed tool calls and parses arguments", () => {
  const decoder = new OpenAIStreamDecoder();
  const first = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\"path\\":\\""}}]}}]}\n';
  const second = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n';
  const events = [...decoder.push(first), ...decoder.push(second), ...decoder.finish()];
  const tool = events.find((event) => event.type === "tool");
  assert.deepEqual(tool, {
    type: "tool",
    tool: {
      id: "call_1",
      name: "read_file",
      input: { path: "README.md" },
    },
  });
});

test("emits final usage metadata", () => {
  const decoder = new OpenAIStreamDecoder();
  const events = decoder.push('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n');
  assert.deepEqual(events, [
    {
      type: "usage",
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
  ]);
});
