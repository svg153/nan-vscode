import assert from "node:assert/strict";
import test from "node:test";
import {
  filterDiscoveredModelIds,
  filterDiscoveredModels,
  knownChatModelIds,
  parseDiscoveredModel,
  reasoningDescription,
  toDisplayMetadata,
  type DiscoveredModel,
} from "../src/modelCatalog";

test("filters known non-chat endpoints and deduplicates discovered models", () => {
  assert.deepEqual(
    filterDiscoveredModelIds([
      "glm5.3-flash",
      "qwen3-embedding",
      "glm5.3-flash",
      "mimo-v2.6-flash",
      "new-chat-model",
      "flux-2-klein",
    ], true),
    ["glm5.3-flash", "mimo-v2.6-flash", "new-chat-model"],
  );
});

test("can hide unknown models for strict compatibility", () => {
  assert.deepEqual(
    filterDiscoveredModelIds(["glm5.3-flash", "new-chat-model"], false),
    ["glm5.3-flash"],
  );
});

test("unknown model metadata is conservative for Agent mode", () => {
  const model = toDisplayMetadata("future-model");
  assert.equal(model.toolCalling, false);
  assert.equal(model.imageInput, false);
  assert.equal(model.contextWindow, 128_000);
});

test("does not advertise XML-only tool formats as VS Code tool calling", () => {
  for (const id of ["qwen3.8-flash", "gemma4", "qwen3.6"]) {
    assert.equal(toDisplayMetadata(id).toolCalling, false, id);
  }
  assert.equal(toDisplayMetadata("mimo-v2.6-flash").toolCalling, true);
});

test("catalog follows NaN cluster changes: MiMo V2.5 removed, Qwen 3.8 Flash at 1M context", () => {
  assert.ok(!knownChatModelIds().includes("mimo-v2.5"));
  assert.equal(toDisplayMetadata("qwen3.8-flash").contextWindow, 1_048_576);
  assert.deepEqual(filterDiscoveredModelIds(["qwen-image-2.1"], true), []);
});

test("premium model metadata is available when the API key reports it", () => {
  assert.ok(knownChatModelIds().includes("glm5.3"));
  assert.equal(toDisplayMetadata("glm5.3").premium, true);
});

test("Mimo V2.6 Flash uses documented limits and supported chat capabilities", () => {
  const model = toDisplayMetadata("mimo-v2.6-flash");
  assert.ok(knownChatModelIds().includes(model.id));
  assert.equal(model.name, "Xiaomi MiMo V2.6 Flash");
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.maxOutputTokens, 32_768);
  assert.equal(model.imageInput, true);
  assert.equal(model.toolCalling, true);
  assert.deepEqual(model.reasoningEffortValues, []);
  assert.match(reasoningDescription(model), /model-managed/);
});

test("reasoning metadata distinguishes adjustable, model-managed, and unknown models", () => {
  assert.match(reasoningDescription(toDisplayMetadata("glm5.3-flash")), /low, medium, high, max/);
  assert.match(reasoningDescription(toDisplayMetadata("qwen3.6")), /none, minimal, low, medium, high, max/);
  assert.match(reasoningDescription(toDisplayMetadata("deepseek-v4-flash")), /model-managed/);
  assert.match(reasoningDescription(toDisplayMetadata("future-model")), /unknown/);
  assert.match(reasoningDescription(toDisplayMetadata("glm5.3-flash")), /nanBuilders\.defaultReasoningEffort/);
});

test("parseDiscoveredModel extracts metadata from raw API response", () => {
  const raw = {
    id: "test-model",
    model_type: "chat",
    is_chat: true,
    context_window: 200_000,
    max_output_tokens: 32_000,
    image_support: true,
    tool_calling: true,
    capabilities: ["vision", "tools"],
  };
  const parsed = parseDiscoveredModel(raw);
  assert.ok(parsed);
  assert.equal(parsed!.id, "test-model");
  assert.equal(parsed!.model_type, "chat");
  assert.equal(parsed!.is_chat, true);
  assert.equal(parsed!.context_window, 200_000);
  assert.equal(parsed!.max_output_tokens, 32_000);
  assert.equal(parsed!.image_support, true);
  assert.equal(parsed!.tool_calling, true);
  assert.deepEqual(parsed!.capabilities, ["vision", "tools"]);
});

test("parseDiscoveredModel rejects invalid input", () => {
  assert.equal(parseDiscoveredModel(null), undefined);
  assert.equal(parseDiscoveredModel("not-an-object"), undefined);
  assert.equal(parseDiscoveredModel({}), undefined);
  assert.equal(parseDiscoveredModel({ id: 123 }), undefined);
  assert.equal(parseDiscoveredModel({ id: "   " }), undefined);
});

test("parseDiscoveredModel handles partial responses", () => {
  const parsed = parseDiscoveredModel({ id: "minimal" });
  assert.ok(parsed);
  assert.equal(parsed!.id, "minimal");
  assert.equal(parsed!.model_type, undefined);
  assert.equal(parsed!.is_chat, undefined);
});

test("filterDiscoveredModels uses API metadata to filter chat models", () => {
  const rawModels: readonly unknown[] = [
    { id: "glm5.3-flash", is_chat: true },
    { id: "qwen3-embedding", is_chat: false },
    { id: "mimo-v2.6-flash", model_type: "chat" },
    { id: "rerank", model_type: "reranker" },
    { id: "unknown-chat", model_type: "chat" },
    { id: "known-but-no-meta" },
  ];

  // With includeUnknown: true, unknown models with chat metadata pass through
  const withUnknown = filterDiscoveredModels(rawModels, true);
  assert.deepEqual(withUnknown.map((m) => m.id).sort(), [
    "glm5.3-flash",
    "known-but-no-meta",
    "mimo-v2.6-flash",
    "unknown-chat",
  ]);

  // With includeUnknown: false, explicit chat metadata still passes (metadata is authoritative)
  // but models with no metadata and no catalog entry are excluded.
  const strict = filterDiscoveredModels(rawModels, false);
  assert.deepEqual(strict.map((m) => m.id).sort(), ["glm5.3-flash", "mimo-v2.6-flash", "unknown-chat"]);
});

test("filterDiscoveredModels deduplicates and preserves first-seen", () => {
  const rawModels: readonly unknown[] = [
    { id: "glm5.3-flash", is_chat: true },
    { id: "glm5.3-flash", is_chat: false },
  ];
  const result = filterDiscoveredModels(rawModels, true);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "glm5.3-flash");
});

test("toDisplayMetadata merges API metadata with catalog defaults", () => {
  const api: DiscoveredModel = {
    id: "future-model",
    context_window: 500_000,
    max_output_tokens: 64_000,
    image_support: true,
    tool_calling: true,
  };
  const metadata = toDisplayMetadata("future-model", api);
  assert.equal(metadata.contextWindow, 500_000);
  assert.equal(metadata.maxOutputTokens, 64_000);
  assert.equal(metadata.imageInput, true);
  assert.equal(metadata.toolCalling, true);
  assert.equal(metadata.name, "future-model");
});

test("toDisplayMetadata clamps maxOutputTokens to contextWindow - 1", () => {
  const api: DiscoveredModel = {
    id: "future-model",
    context_window: 10_000,
    max_output_tokens: 50_000,
  };
  const metadata = toDisplayMetadata("future-model", api);
  assert.equal(metadata.maxOutputTokens, 9_999);
});

test("toDisplayMetadata respects catalog toolCalling=false for XML-only models", () => {
  const api: DiscoveredModel = {
    id: "qwen3.8-flash",
    tool_calling: true,
  };
  const metadata = toDisplayMetadata("qwen3.8-flash", api);
  assert.equal(metadata.toolCalling, false, "catalog should override API for XML-only models");
});
