import assert from "node:assert/strict";
import test from "node:test";
import { buildAvailableModelPickItems, formatTokenCount } from "../src/availableModelPicker";

const MODELS = [
  {
    id: "glm5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    imageInput: true,
    toolCalling: true,
  },
  {
    id: "qwen3.6",
    name: "Qwen 3.6",
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    imageInput: false,
    toolCalling: false,
    largerModel: true,
  },
];

test("buildAvailableModelPickItems formats context and capability hints", () => {
  const items = buildAvailableModelPickItems(MODELS);
  assert.deepEqual(
    items.map((item) => item.model),
    ["glm5.3-flash", "qwen3.6"],
  );
  assert.equal(items[0].label, "GLM 5.3 Flash");
  assert.equal(items[0].description, "glm5.3-flash · 1,048,576 context");
  assert.equal(items[0].detail, "32,768 max output · image input · tool calling");
  assert.equal(items[1].description, "qwen3.6 · 262,144 context");
  assert.equal(
    items[1].detail,
    "65,536 max output · text-only input · no tool calling · larger model (costs more per token)",
  );
});

test("buildAvailableModelPickItems uses the id when the model has no name", () => {
  const items = buildAvailableModelPickItems([
    {
      id: "kimi-k3",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      imageInput: false,
      toolCalling: false,
    },
  ]);
  assert.equal(items[0].label, "kimi-k3");
  assert.equal(items[0].description, "131,072 context");
});

test("buildAvailableModelPickItems drops blank and duplicate ids", () => {
  const items = buildAvailableModelPickItems([
    { ...MODELS[0], id: " " },
    MODELS[0],
    { ...MODELS[0], id: " glm5.3-flash ", name: "Duplicate" },
    { ...MODELS[1], name: "" },
  ]);
  assert.deepEqual(
    items.map((item) => item.model),
    ["glm5.3-flash", "qwen3.6"],
  );
  assert.equal(items[0].label, "GLM 5.3 Flash");
  assert.equal(items[1].label, "qwen3.6");
});

test("formatTokenCount is locale-independent and clamps negatives", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_000), "1,000");
  assert.equal(formatTokenCount(1_048_576), "1,048,576");
  assert.equal(formatTokenCount(12_345.6), "12,346");
  assert.equal(formatTokenCount(-1), "0");
});
