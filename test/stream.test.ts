import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SSE_LINE_CHARS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS,
  MAX_TOOL_METADATA_CHARS,
  OpenAIStreamDecoder,
  StreamLimitError,
} from "../src/openai/stream";

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

test("accepts an SSE line exactly at its configured character limit", () => {
  const decoder = new OpenAIStreamDecoder();
  const prefix = 'data: {"choices":[{"delta":{"content":"x"}}]}';
  const line = prefix + " ".repeat(MAX_SSE_LINE_CHARS - prefix.length);
  assert.equal(line.length, MAX_SSE_LINE_CHARS);
  assert.deepEqual(decoder.push(`${line}\n`), [{ type: "text", text: "x" }]);
});

test("stops buffering an unterminated SSE line as soon as it exceeds the limit", () => {
  const decoder = new OpenAIStreamDecoder();
  decoder.push("x".repeat(MAX_SSE_LINE_CHARS));
  let failure: unknown;
  assert.throws(
    () => decoder.push("y"),
    (error: unknown) => {
      failure = error;
      return error instanceof StreamLimitError && error.kind === "line" && error.limit === MAX_SSE_LINE_CHARS;
    },
  );
  assert.throws(() => decoder.finish(), (error: unknown) => error === failure);
});

test("accepts tool arguments exactly at their configured character limit", () => {
  const decoder = new OpenAIStreamDecoder();
  const args = "x".repeat(MAX_TOOL_ARGUMENT_CHARS);
  const payload = {
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "tool", arguments: args } }] } }],
  };
  assert.deepEqual(decoder.push(`data: ${JSON.stringify(payload)}\n`), []);
  const [event] = decoder.finish();
  assert.equal(event.type, "tool");
  if (event.type === "tool") {
    assert.equal(event.tool.input.__raw, args);
  }
});

test("rejects oversized tool arguments and never flushes the partial tool call", () => {
  const decoder = new OpenAIStreamDecoder();
  const sendArguments = (argumentsPart: string): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "tool", arguments: argumentsPart } }],
          },
        },
      ],
    })}\n`;
  decoder.push(sendArguments("x".repeat(MAX_TOOL_ARGUMENT_CHARS)));
  let failure: unknown;
  assert.throws(
    () => decoder.push(sendArguments("y")),
    (error: unknown) => {
      failure = error;
      return error instanceof StreamLimitError && error.kind === "tool_arguments";
    },
  );
  assert.throws(() => decoder.finish(), (error: unknown) => error === failure);
});

test("caps the number of buffered tool calls", () => {
  const decoder = new OpenAIStreamDecoder();
  const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_value, index) => ({
    index,
    function: { name: "t", arguments: "" },
  }));
  const payload = { choices: [{ delta: { tool_calls: calls } }] };
  assert.throws(
    () => decoder.push(`data: ${JSON.stringify(payload)}\n`),
    (error: unknown) => error instanceof StreamLimitError && error.kind === "tool_calls",
  );
  assert.throws(() => decoder.finish(), StreamLimitError);
});

test("caps accumulated tool metadata", () => {
  const decoder = new OpenAIStreamDecoder();
  const sendName = (name: string): string =>
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: "" } }] } }],
    })}\n`;
  decoder.push(sendName("n".repeat(MAX_TOOL_METADATA_CHARS)));
  assert.throws(
    () => decoder.push(sendName("n")),
    (error: unknown) => error instanceof StreamLimitError && error.kind === "tool_metadata",
  );
});
