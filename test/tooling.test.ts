import assert from "node:assert/strict";
import test from "node:test";
import { buildToolNameMappings, sanitizeSchema, sanitizeToolName } from "../src/openai/tooling";

test("sanitizes OpenAI-incompatible tool names", () => {
  assert.equal(sanitizeToolName("mcp.server/read file"), "mcp_server_read_file");
  assert.equal(sanitizeToolName("123.tool"), "tool_123_tool");
});

test("keeps colliding sanitized names unique and reversible", () => {
  const maps = buildToolNameMappings(["a.b", "a/b", "a_b"]);
  const values = [...maps.originalToSanitized.values()];
  assert.equal(new Set(values).size, 3);
  for (const [original, sanitized] of maps.originalToSanitized) {
    assert.equal(maps.sanitizedToOriginal.get(sanitized), original);
  }
});

test("falls back to an object schema when a tool has no valid schema", () => {
  assert.deepEqual(sanitizeSchema(undefined), { type: "object", properties: {} });
});
