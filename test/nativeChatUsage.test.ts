import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNativeChatUsage, reportNativeChatUsage, supportsNativeChatUsage } from "../src/nativeChatUsage";
import type { OpenAIUsage } from "../src/openai/types";

class FakeDataPart {
  constructor(readonly data: Uint8Array, readonly mimeType: string) {}
}

const measured: OpenAIUsage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

test("preserves complete measured token counts and derives total only when omitted", () => {
  assert.deepEqual(normalizeNativeChatUsage(measured), measured);
  assert.deepEqual(normalizeNativeChatUsage({ prompt_tokens: 2, completion_tokens: 3 }), {
    prompt_tokens: 2, completion_tokens: 3, total_tokens: 5,
  });
  assert.deepEqual(normalizeNativeChatUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  });
  assert.deepEqual(normalizeNativeChatUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 }), {
    prompt_tokens: 2, completion_tokens: 3, total_tokens: 6,
  });
});

test("does not conflate unknown or invalid counts with measured zero", () => {
  const invalid: OpenAIUsage[] = [
    {}, { prompt_tokens: 0 }, { completion_tokens: 0 },
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1.5, completion_tokens: 1 },
    { prompt_tokens: Number.NaN, completion_tokens: 1 },
    { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 0 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: 4 },
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: -1 },
    { prompt_tokens: 2, completion_tokens: 3, total_tokens: null as unknown as number },
    { prompt_tokens: 2, completion_tokens: 3, estimated: true },
    { prompt_tokens: 2, completion_tokens: 3, nan_truncation: true },
  ];
  for (const bad of invalid) {
    assert.equal(normalizeNativeChatUsage(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(normalizeNativeChatUsage(undefined), undefined);
});

test("gates undocumented usage data parts to 1.146+ supported version strings", () => {
  for (const version of ["1.146.0", "1.146.0-insider", "1.147.2", "2.0.0"]) {
    assert.equal(supportsNativeChatUsage(version), true, version);
  }
  for (const version of ["1.104.0", "1.145.99", "0.99.0", "", "1.146x", "latest", "1.146.0/invalid"]) {
    assert.equal(supportsNativeChatUsage(version), false, version);
  }
});

test("emits one well-formed usage part on successful opt-in reporting", () => {
  const parts: FakeDataPart[] = [];
  const succeeded = reportNativeChatUsage(measured, {
    enabled: true,
    version: "1.146.0-insider",
    cancelled: false,
    DataPart: FakeDataPart,
    report: (part) => parts.push(part),
  });
  assert.equal(succeeded, true);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].mimeType, "usage");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(parts[0].data)), measured);
});

test("opt-out, old hosts, missing API, and cancellation do not report usage", () => {
  for (const patch of [
    { enabled: false },
    { version: "1.145.0" },
    { cancelled: true },
    { DataPart: undefined },
  ]) {
    let calls = 0;
    assert.equal(reportNativeChatUsage(measured, {
      enabled: true,
      version: "1.146.0",
      cancelled: false,
      DataPart: FakeDataPart,
      report: () => { calls++; },
      ...patch,
    }), false);
    assert.equal(calls, 0);
  }

  let calls = 0;
  for (const usage of [undefined, { prompt_tokens: 3 }, { ...measured, nan_truncation: true }]) {
    assert.equal(reportNativeChatUsage(usage, {
      enabled: true, version: "1.146.0", cancelled: false, DataPart: FakeDataPart,
      report: () => { calls++; },
    }), false);
  }
  assert.equal(calls, 0);
});

test("an experimental host that rejects the data part cannot fail chat", () => {
  assert.doesNotThrow(() => {
    const delivered = reportNativeChatUsage(measured, {
      enabled: true, version: "1.146.0", cancelled: false, DataPart: FakeDataPart,
      report: () => { throw new Error("unsupported usage part"); },
    });
    assert.equal(delivered, false);
  });
});
