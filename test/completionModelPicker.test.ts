import assert from "node:assert/strict";
import test from "node:test";
import {
  DISABLE_COMPLETION_MODEL_LABEL,
  buildCompletionModelPickItems,
  completionModelFromPick,
} from "../src/completionModelPicker";

const MODELS = [
  { id: "glm5.3-flash", name: "GLM 5.3 Flash" },
  { id: "qwen3.8-max" },
];

test("buildCompletionModelPickItems lists discovered models then the disable row", () => {
  const items = buildCompletionModelPickItems(MODELS, "");
  assert.deepEqual(
    items.map((item) => item.model),
    ["glm5.3-flash", "qwen3.8-max", ""],
  );
  assert.equal(items[0].label, "GLM 5.3 Flash");
  assert.equal(items[0].description, "glm5.3-flash");
  assert.equal(items[1].label, "qwen3.8-max");
  assert.equal(items.at(-1)?.label, DISABLE_COMPLETION_MODEL_LABEL);
  assert.equal(items.at(-1)?.description, "Inline completions are already off");
});

test("buildCompletionModelPickItems marks the configured model", () => {
  const items = buildCompletionModelPickItems(MODELS, " qwen3.8-max ");
  assert.equal(items[0].description, "glm5.3-flash");
  assert.equal(items[1].description, "$(checkmark) current");
  assert.equal(items[1].detail, "Inline completions already use this model.");
  assert.equal(items.at(-1)?.description, "Clears nanBuilders.completionModel");
});

test("buildCompletionModelPickItems drops blank and duplicate ids", () => {
  const items = buildCompletionModelPickItems(
    [
      { id: " " },
      { id: "glm5.3-flash", name: "GLM 5.3 Flash" },
      { id: " glm5.3-flash ", name: "Duplicate" },
      { id: "kimi-k3", name: "" },
    ],
    "",
  );
  assert.deepEqual(
    items.map((item) => item.model),
    ["glm5.3-flash", "kimi-k3", ""],
  );
  assert.equal(items[0].label, "GLM 5.3 Flash");
  assert.equal(items[1].label, "kimi-k3");
});

test("completionModelFromPick distinguishes dismissal, disable, and a model", () => {
  assert.equal(completionModelFromPick(undefined), undefined);
  assert.equal(completionModelFromPick({ model: "", label: DISABLE_COMPLETION_MODEL_LABEL }), "");
  assert.equal(completionModelFromPick({ model: "glm5.3-flash", label: "GLM 5.3 Flash" }), "glm5.3-flash");
});
