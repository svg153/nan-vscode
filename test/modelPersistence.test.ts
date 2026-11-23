import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PERSISTED_MODEL_AGE_MS,
  PERSISTED_MODELS_VERSION,
  parsePersistedModelList,
  serializeModelList,
} from "../src/modelPersistence";
import type { DiscoveredModel } from "../src/modelCatalog";

const NOW = 1_700_000_000_000;

const models: DiscoveredModel[] = [
  {
    id: "future-chat-model",
    model_type: "chat",
    is_chat: true,
    context_window: 200_000,
    max_output_tokens: 32_000,
    image_support: true,
    tool_calling: true,
    capabilities: ["chat", "tools"],
  },
  { id: "mimo-v2.6-flash" },
];

test("serialized model lists round-trip and keep only model metadata", () => {
  const raw = serializeModelList(
    [
      ...models,
      // Unknown fields (such as an endpoint or key) must never be persisted.
      { ...models[0]!, api_key: "secret", endpoint: "https://gateway.test/v1" } as DiscoveredModel,
    ],
    NOW,
  );

  assert.doesNotMatch(raw, /secret|gateway\.test/);
  assert.deepEqual(parsePersistedModelList(raw, NOW), models);
});

test("persisted lists with an unknown schema version are ignored", () => {
  const raw = JSON.stringify({
    version: PERSISTED_MODELS_VERSION + 1,
    savedAt: NOW,
    models,
  });

  assert.equal(parsePersistedModelList(raw, NOW), undefined);
});

test("corrupted persisted JSON is ignored without throwing", () => {
  for (const raw of ["{", "null", "[]", '"text"', "42"]) {
    assert.equal(parsePersistedModelList(raw, NOW), undefined, raw);
  }
});

test("an empty persisted list is treated as absent", () => {
  assert.equal(parsePersistedModelList(serializeModelList([], NOW), NOW), undefined);
  assert.equal(
    parsePersistedModelList(JSON.stringify({ version: PERSISTED_MODELS_VERSION, savedAt: NOW, models: [] }), NOW),
    undefined,
  );
});

test("partially invalid persisted entries are dropped and the valid ones kept", () => {
  const raw = JSON.stringify({
    version: PERSISTED_MODELS_VERSION,
    savedAt: NOW,
    models: [
      { id: "valid-model" },
      { id: "   " },
      { name: "missing id" },
      null,
      "not-an-object",
      { id: "valid-model", context_window: -1 },
      { id: "negative-model", context_window: -1 },
      { id: "other-model", context_window: "not-a-number" },
    ],
  });

  assert.deepEqual(parsePersistedModelList(raw, NOW), [
    { id: "valid-model" },
    { id: "negative-model" },
    { id: "other-model" },
  ]);
});

test("stale or future-dated persisted lists are ignored", () => {
  const stale = serializeModelList(models, NOW - MAX_PERSISTED_MODEL_AGE_MS - 1);
  assert.equal(parsePersistedModelList(stale, NOW), undefined);

  const future = serializeModelList(models, NOW + 60_000);
  assert.equal(parsePersistedModelList(future, NOW), undefined);

  const fresh = serializeModelList(models, NOW - MAX_PERSISTED_MODEL_AGE_MS);
  assert.deepEqual(parsePersistedModelList(fresh, NOW), models);
});

test("malformed envelopes are ignored", () => {
  for (const payload of [
    null,
    undefined,
    42,
    {},
    { version: PERSISTED_MODELS_VERSION, savedAt: NOW },
    { version: PERSISTED_MODELS_VERSION, savedAt: "now", models },
    { version: PERSISTED_MODELS_VERSION, savedAt: NOW, models: "nope" },
  ]) {
    assert.equal(parsePersistedModelList(JSON.stringify(payload), NOW), undefined, JSON.stringify(payload));
  }
});
