import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_TOKENS,
  countContentTokens,
  estimateHistoryTokens,
  estimateTokens,
  flattenToolResult,
} from "../src/openai/tokens";
import { convertMessages } from "../src/openai/request";

const image = (mimeType = "image/png") => ({ mimeType, data: new Uint8Array([1, 2, 3]) });

test("keeps the four-characters-per-token rule for text", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("abcdefgh"), countContentTokens([{ value: "abcdefgh" }]));
});

test("charges a flat per-image cost instead of the encoded byte length", () => {
  const textOnly = countContentTokens([{ value: "look" }]);
  const withImages = countContentTokens([{ value: "look" }, image(), image("image/jpeg")]);

  assert.equal(IMAGE_TOKENS, 1024);
  assert.equal(withImages - textOnly, 2 * IMAGE_TOKENS);
  assert.equal(countContentTokens([image()]), IMAGE_TOKENS);
});

test("counts a mixed message with text, an image and a tool result holding an image", () => {
  const toolContent = [{ value: "y".repeat(100) }, image("image/webp")];
  const tokens = countContentTokens([
    { value: "x".repeat(400) },
    image(),
    { callId: "call-1", content: toolContent },
  ]);

  // The tool result is charged as the flattened string sent upstream, not as
  // "text plus one flat image", so its serialized image bytes are counted.
  assert.equal(tokens, 100 + IMAGE_TOKENS + estimateTokens(flattenToolResult(toolContent)));
});

test("counts tool-call names and their serialized arguments", () => {
  const call = { callId: "call-1", name: "read_file", input: { path: "a.ts" } };
  const serialized = 'read_file{"path":"a.ts"}';

  assert.equal(serialized.length, 24);
  assert.equal(countContentTokens([call]), estimateTokens(serialized));
  assert.equal(countContentTokens([call]), 6);
});

test("counts deeply nested tool-call arguments", () => {
  const call = { callId: "call-1", name: "nested", input: { a: { b: [1, 2, 3] }, c: null } };
  const serialized = 'nested{"a":{"b":[1,2,3]},"c":null}';

  assert.equal(countContentTokens([call]), estimateTokens(serialized));
});

test("counts nested tool calls and images inside tool results", () => {
  const nestedCall = { callId: "call-2", name: "t", input: { a: 1 } };
  const toolContent = [{ value: "done" }, image(), nestedCall];
  const tokens = countContentTokens([
    {
      callId: "call-1",
      content: toolContent,
    },
  ]);

  assert.equal(tokens, estimateTokens(flattenToolResult(toolContent)));
});

test("counts a tool result exactly as the request builder serializes it", () => {
  const toolContent = [{ value: "done" }, image("image/png"), { structured: { ok: true } }];
  const converted = convertMessages(
    [{ role: "user", content: [{ callId: "call-1", content: toolContent }] }],
    new Map(),
  );
  const sent = converted.find((message) => message.role === "tool");

  assert.ok(sent);
  assert.equal(typeof sent.content, "string");
  const sentText = sent.content as string;
  assert.equal(countContentTokens([{ callId: "call-1", content: toolContent }]), estimateTokens(sentText));
  assert.notEqual(
    countContentTokens([{ callId: "call-1", content: toolContent }]),
    estimateTokens("done") + IMAGE_TOKENS,
  );
});

test("charges a tool-result image by its serialized size, not the flat image cost", () => {
  const bytes = new Uint8Array(8 * 1024).fill(7);
  const toolContent = [{ mimeType: "image/png", data: bytes }];
  const converted = convertMessages(
    [{ role: "user", content: [{ callId: "call-1", content: toolContent }] }],
    new Map(),
  );
  const sent = converted.find((message) => message.role === "tool");
  assert.ok(sent && typeof sent.content === "string");

  const counted = countContentTokens([{ callId: "call-1", content: toolContent }]);
  assert.equal(counted, estimateTokens(sent.content as string));
  assert.ok(counted > IMAGE_TOKENS);
});

test("keeps the previous fixed allowance for unrecognized parts", () => {
  assert.equal(countContentTokens([{ mimeType: "application/json", data: new Uint8Array([0]) }]), 16);
});

test("floors an empty message at one token", () => {
  assert.equal(countContentTokens([]), 1);
});

test("the history estimator and the host counting path agree on the same payload", () => {
  const payload = [
    { value: "hello world" },
    image(),
    { callId: "call-1", name: "search", input: { q: "x" } },
    { callId: "call-1", content: [{ value: "result" }, image("image/jpeg")] },
  ];
  const second = { content: [{ value: "second message" }] };

  assert.equal(estimateHistoryTokens([{ content: payload }]), countContentTokens(payload));
  assert.equal(
    estimateHistoryTokens([{ content: payload }, second]),
    countContentTokens(payload) + countContentTokens(second.content),
  );
});
