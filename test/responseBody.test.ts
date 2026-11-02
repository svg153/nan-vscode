import assert from "node:assert/strict";
import test from "node:test";
import { ResponseTooLargeError, readBoundedJson, readBoundedResponseText } from "../src/responseBody";

function streamedResponse(chunks: Uint8Array[], onCancel: () => void): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel();
    },
  }, { highWaterMark: 0 });
  return new Response(body);
}

test("bounded JSON accepts a body exactly at the byte limit", async () => {
  const bytes = new TextEncoder().encode('{"ok":true}');
  const response = streamedResponse([bytes.slice(0, 4), bytes.slice(4)], () => undefined);
  assert.deepEqual(await readBoundedJson(response, bytes.byteLength), { ok: true });
});

test("bounded text decodes multibyte characters split across chunks", async () => {
  const encoded = new TextEncoder().encode("split 世界");
  const response = streamedResponse([encoded.slice(0, 7), encoded.slice(7, 9), encoded.slice(9)], () => undefined);
  assert.equal(await readBoundedResponseText(response, encoded.byteLength), "split 世界");
});

test("bounded text rejects streamed bytes over the limit and cancels the response", async () => {
  let cancelled = false;
  const response = streamedResponse(
    [new Uint8Array([65, 66]), new Uint8Array([67, 68])],
    () => {
      cancelled = true;
    },
  );
  await assert.rejects(readBoundedResponseText(response, 3), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.limitBytes, 3);
    assert.equal(error.message, "Upstream response exceeded the maximum allowed size.");
    assert.equal(error.message.includes("ABCD"), false);
    return true;
  });
  assert.equal(cancelled, true);
});
