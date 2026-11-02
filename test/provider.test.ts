import assert from "node:assert/strict";
import test from "node:test";
import {
  convertMessages,
  convertTools,
  estimateTokens,
  httpError,
  isImagePart,
  reasoningEffort,
} from "../src/openai/request";

const noMapping = new Map<string, string>();

test("converts a plain user message into a single text message", () => {
  const messages = convertMessages([{ role: "user", content: [{ value: "hello" }] }], noMapping);
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("joins multiple text parts into one string", () => {
  const messages = convertMessages([{ role: "assistant", content: [{ value: "a" }, { value: "b" }] }], noMapping);
  assert.deepEqual(messages, [{ role: "assistant", content: "ab" }]);
});

test("converts tool calls and tool results into separate messages", () => {
  const mapping = new Map([["read.file", "read_file"]]);
  const messages = convertMessages(
    [
      {
        role: "assistant",
        content: [
          { value: "reading" },
          { callId: "call-1", name: "read.file", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ callId: "call-1", content: [{ value: "contents" }] }] },
    ],
    mapping,
  );

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: "reading",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "contents" },
  ]);
});

test("sanitizes tool names that are missing from the mapping", () => {
  const messages = convertMessages(
    [{ role: "assistant", content: [{ callId: "c", name: "mcp.server/read", input: {} }] }],
    noMapping,
  );
  assert.equal(messages[0].tool_calls?.[0].function.name, "mcp_server_read");
});

test("emits null content when an assistant turn only contains tool calls", () => {
  const messages = convertMessages(
    [{ role: "assistant", content: [{ callId: "c", name: "t", input: {} }] }],
    noMapping,
  );
  assert.equal(messages[0].content, null);
});

test("converts image parts into base64 data URLs", () => {
  const data = new Uint8Array([1, 2, 3]);
  const messages = convertMessages([{ role: "user", content: [{ mimeType: "image/png", data }] }], noMapping);
  assert.deepEqual(messages, [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(data).toString("base64")}` } }],
    },
  ]);
});

test("keeps mixed text and image parts as an array", () => {
  const messages = convertMessages(
    [{ role: "user", content: [{ value: "look" }, { mimeType: "image/png", data: new Uint8Array([0]) }] }],
    noMapping,
  );
  assert.equal(Array.isArray(messages[0].content), true);
  assert.equal((messages[0].content as unknown[]).length, 2);
});

test("flattens string and structured tool result content", () => {
  const messages = convertMessages(
    [{ role: "user", content: [{ callId: "c", content: ["plain", { value: "text" }, { ok: true }] }] }],
    noMapping,
  );
  assert.equal(messages[0].content, 'plaintext{"ok":true}');
});

test("ignores parts that are not recognized", () => {
  const messages = convertMessages([{ role: "user", content: [{ unknown: true }] }], noMapping);
  assert.deepEqual(messages, []);
});

test("builds tool definitions with sanitized names and schemas", () => {
  const mapping = convertTools(
    [{ name: "mcp.read", description: "reads", inputSchema: { type: "object", properties: { p: { type: "string" } } } }],
    false,
  );

  assert.equal(mapping.definitions.length, 1);
  assert.equal(mapping.definitions[0].function.name, "mcp_read");
  assert.equal(mapping.definitions[0].function.description, "reads");
  assert.deepEqual(mapping.definitions[0].function.parameters, {
    type: "object",
    properties: { p: { type: "string" } },
  });
  assert.equal(mapping.originalToSanitized.get("mcp.read"), "mcp_read");
  assert.equal(mapping.sanitizedToOriginal.get("mcp_read"), "mcp.read");
  assert.equal(mapping.toolChoice, "auto");
});

test("falls back to an empty object schema for invalid tool schemas", () => {
  const mapping = convertTools([{ name: "t", inputSchema: "not-a-schema" }], false);
  assert.deepEqual(mapping.definitions[0].function.parameters, { type: "object", properties: {} });
});

test("forces required tool choice when the caller requests it", () => {
  assert.equal(convertTools([{ name: "t" }], true).toolChoice, "required");
});

test("leaves tool choice undefined when no tools are provided", () => {
  const mapping = convertTools([], false);
  assert.equal(mapping.definitions.length, 0);
  assert.equal(mapping.toolChoice, undefined);
});

test("accepts supported reasoning efforts and defaults to low", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "max"]) {
    assert.equal(reasoningEffort({ reasoning_effort: effort }), effort);
  }
  assert.equal(reasoningEffort({ reasoning_effort: "extreme" }), "low");
  assert.equal(reasoningEffort({ reasoning_effort: 3 }), "low");
  assert.equal(reasoningEffort({}), "low");
  assert.equal(reasoningEffort(undefined), "low");
});

test("estimates tokens with a floor of one", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("formats HTTP errors with status, status text and structural error fields", () => {
  const error = httpError(429, "Too Many Requests", '{"error":{"type":"rate_limit","code":"slow_down"}}');
  assert.equal(error.message, "NaN Builders API error 429 Too Many Requests: rate_limit slow_down");
});

test("omits the body suffix when the response body is empty", () => {
  assert.equal(httpError(500, "Internal Server Error", "   ").message, "NaN Builders API error 500 Internal Server Error");
});

test("does not echo prompt content from long upstream bodies", () => {
  const prompt = "my private prompt ".repeat(40);
  const error = httpError(400, "Bad Request", JSON.stringify({ error: { message: prompt } }));
  assert.equal(error.message, "NaN Builders API error 400 Bad Request");
  assert.equal(error.message.includes("my private prompt"), false);
});

test("drops non-JSON bodies instead of surfacing them", () => {
  const error = httpError(502, "Bad Gateway", "<html>upstream echoed the request body</html>");
  assert.equal(error.message, "NaN Builders API error 502 Bad Gateway");
});

test("redacts credential-like tokens in structural error fields", () => {
  const error = httpError(401, "Unauthorized", '{"error":{"code":"sk-live-abc123456","type":"auth"}}');
  assert.equal(error.message.includes("sk-live-abc123456"), false);
  assert.equal(error.message, "NaN Builders API error 401 Unauthorized: auth ******");
});

test("redacts bearer tokens in structural error fields", () => {
  const error = httpError(401, "Unauthorized", '{"error":{"code":"Bearer abcdef123456"}}');
  assert.equal(error.message.includes("abcdef123456"), false);
});

test("bounds the sanitized summary length", () => {
  const error = httpError(400, "Bad Request", JSON.stringify({ error: { type: "t".repeat(400) } }));
  assert.equal(error.message.length, "NaN Builders API error 400 Bad Request: ".length + 64);
});

test("detects image parts only for image mime types backed by bytes", () => {
  assert.equal(isImagePart({ mimeType: "image/png", data: new Uint8Array([0]) }), true);
  assert.equal(isImagePart({ mimeType: "text/plain", data: new Uint8Array([0]) }), false);
  assert.equal(isImagePart({ mimeType: "image/png", data: "not-bytes" }), false);
  assert.equal(isImagePart(null), false);
});
