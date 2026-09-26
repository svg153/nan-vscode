import assert from "node:assert/strict";
import test from "node:test";
import { filterDiscoveredModelIds, knownChatModelIds, reasoningDescription, toDisplayMetadata } from "../src/modelCatalog";

test("filters known non-chat endpoints and deduplicates discovered models", () => {
  assert.deepEqual(
    filterDiscoveredModelIds([
      "glm5.3-flash",
      "qwen3-embedding",
      "glm5.3-flash",
      "new-chat-model",
      "flux-2-klein",
    ], true),
    ["glm5.3-flash", "new-chat-model"],
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
  assert.equal(toDisplayMetadata("mimo-v2.5").toolCalling, true);
});

test("premium model metadata is available when the API key reports it", () => {
  assert.ok(knownChatModelIds().includes("glm5.3"));
  assert.equal(toDisplayMetadata("glm5.3").premium, true);
});

test("reasoning metadata distinguishes adjustable, model-managed, and unknown models", () => {
  assert.match(reasoningDescription(toDisplayMetadata("glm5.3-flash")), /low, medium, high, max/);
  assert.match(reasoningDescription(toDisplayMetadata("qwen3.6")), /none, minimal, low, medium, high, max/);
  assert.match(reasoningDescription(toDisplayMetadata("deepseek-v4-flash")), /model-managed/);
  assert.match(reasoningDescription(toDisplayMetadata("future-model")), /unknown/);
});
