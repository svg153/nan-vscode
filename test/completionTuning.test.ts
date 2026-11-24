import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPLETION_DEBOUNCE_MS,
  DEFAULT_COMPLETION_MAX_TOKENS,
  MAX_COMPLETION_DEBOUNCE_MS,
  MAX_COMPLETION_MAX_TOKENS,
  MIN_COMPLETION_DEBOUNCE_MS,
  MIN_COMPLETION_MAX_TOKENS,
  resolveCompletionDebounceMs,
  resolveCompletionMaxTokens,
} from "../src/completionTuning";

test("completion tuning keeps the current behaviour as its default", () => {
  assert.equal(DEFAULT_COMPLETION_MAX_TOKENS, 64);
  assert.equal(DEFAULT_COMPLETION_DEBOUNCE_MS, 150);
  assert.equal(MIN_COMPLETION_MAX_TOKENS, 16);
  assert.equal(MAX_COMPLETION_MAX_TOKENS, 512);
  assert.equal(MIN_COMPLETION_DEBOUNCE_MS, 0);
  assert.equal(MAX_COMPLETION_DEBOUNCE_MS, 2000);
});

test("completion tuning accepts in-range overrides and boundaries", () => {
  assert.equal(resolveCompletionMaxTokens(128), 128);
  assert.equal(resolveCompletionMaxTokens(MIN_COMPLETION_MAX_TOKENS), MIN_COMPLETION_MAX_TOKENS);
  assert.equal(resolveCompletionMaxTokens(MAX_COMPLETION_MAX_TOKENS), MAX_COMPLETION_MAX_TOKENS);
  assert.equal(resolveCompletionDebounceMs(400), 400);
  assert.equal(resolveCompletionDebounceMs(MIN_COMPLETION_DEBOUNCE_MS), MIN_COMPLETION_DEBOUNCE_MS);
  assert.equal(resolveCompletionDebounceMs(MAX_COMPLETION_DEBOUNCE_MS), MAX_COMPLETION_DEBOUNCE_MS);
});

test("completion tuning silently falls back for invalid values", () => {
  for (const value of [undefined, null, "128", 15, 513, -1, 64.5, Number.NaN, Infinity, -Infinity, {}]) {
    assert.equal(resolveCompletionMaxTokens(value), DEFAULT_COMPLETION_MAX_TOKENS);
  }
  for (const value of [undefined, null, "400", -1, 2001, 150.5, Number.NaN, Infinity, -Infinity, {}]) {
    assert.equal(resolveCompletionDebounceMs(value), DEFAULT_COMPLETION_DEBOUNCE_MS);
  }
});
