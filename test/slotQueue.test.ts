import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_PARALLEL_REQUESTS,
  GATEWAY_MAX_PARALLEL_REQUESTS,
  SlotQueue,
  SlotQueueCancelledError,
  SlotQueueRegistry,
  credentialId,
  resolveMaxParallelRequests,
  type SlotLease,
} from "../src/openai/slotQueue";

/** Lets already-resolved promises and queued handoffs run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await Promise.resolve();
  }
}

test("ten requests against the gateway limit run seven at a time in order", async () => {
  const queue = new SlotQueue(GATEWAY_MAX_PARALLEL_REQUESTS);
  const started: number[] = [];
  const held: SlotLease[] = [];
  const requests: Promise<void>[] = [];
  for (let index = 0; index < 10; index += 1) {
    requests.push(
      queue.acquire().then((lease) => {
        started.push(index);
        held.push(lease);
      }),
    );
  }

  // Slots are taken synchronously, so no timer or microtask is needed to fill
  // the queue to capacity.
  assert.equal(queue.capacity, 7);
  assert.equal(queue.inUse, 7);
  assert.equal(queue.pending, 3);
  await settle();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);

  for (const lease of held.splice(0)) {
    lease.release();
  }
  assert.equal(queue.pending, 0);
  await settle();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(queue.inUse, 3);

  for (const lease of held.splice(0)) {
    lease.release();
  }
  assert.equal(queue.inUse, 0);
  await Promise.all(requests);
});

test("a request with a free slot acquires it without waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new SlotQueue(DEFAULT_MAX_PARALLEL_REQUESTS);

  const pending = queue.acquire();
  // No timer tick: a single request never waits behind the queue.
  assert.equal(queue.inUse, 1);
  const lease = await pending;
  assert.equal(lease.waited, false);
  lease.release();
  assert.equal(queue.inUse, 0);
});

test("a cancelled waiter leaves the queue without taking a slot", async () => {
  const queue = new SlotQueue(1);
  const first = await queue.acquire();
  const controller = new AbortController();
  const waiting = queue.acquire(controller.signal);
  assert.equal(queue.pending, 1);

  controller.abort();
  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof SlotQueueCancelledError);
    // Transport aborts use this name, so callers map it to a cancellation.
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(queue.pending, 0);
  assert.equal(queue.inUse, 1);

  first.release();
  const next = await queue.acquire();
  assert.equal(next.waited, false);
  next.release();
});

test("an already aborted signal rejects without queueing", async () => {
  const queue = new SlotQueue(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.acquire(controller.signal), SlotQueueCancelledError);
  assert.equal(queue.inUse, 0);
  assert.equal(queue.pending, 0);
});

test("releasing twice frees one slot and hands it to the next waiter", async () => {
  const queue = new SlotQueue(1);
  let handedOver = false;
  const lease = await queue.acquire();
  const waiting = queue.acquire().then((next) => {
    handedOver = true;
    return next;
  });

  lease.release();
  lease.release();
  assert.equal(queue.inUse, 1);
  const next = await waiting;
  assert.equal(handedOver, true);
  assert.equal(next.waited, true);
  next.release();
  assert.equal(queue.inUse, 0);
});

test("a failed request frees its slot for the next waiter", async () => {
  const queue = new SlotQueue(1);
  const first = await queue.acquire();
  const waiting = queue.acquire();
  try {
    await Promise.reject(new Error("gateway 429"));
  } catch {
    first.release();
  }
  const second = await waiting;
  assert.equal(second.waited, true);
  assert.equal(queue.inUse, 1);
  second.release();
  assert.equal(queue.inUse, 0);
});

test("capacity changes apply to waiters already in the queue", async () => {
  let capacity = 1;
  const queue = new SlotQueue(() => capacity);
  const first = await queue.acquire();
  const second = queue.acquire();
  assert.equal(queue.pending, 1);

  capacity = 2;
  queue.refresh();
  const lease = await second;
  assert.equal(lease.waited, true);
  assert.equal(queue.inUse, 2);

  first.release();
  lease.release();
  assert.equal(queue.inUse, 0);
});

test("capacity resolves to an integer within the gateway limit", () => {
  assert.equal(resolveMaxParallelRequests(undefined), DEFAULT_MAX_PARALLEL_REQUESTS);
  assert.equal(resolveMaxParallelRequests(Number.NaN), DEFAULT_MAX_PARALLEL_REQUESTS);
  assert.equal(resolveMaxParallelRequests(Number.POSITIVE_INFINITY), DEFAULT_MAX_PARALLEL_REQUESTS);
  assert.equal(resolveMaxParallelRequests("4"), DEFAULT_MAX_PARALLEL_REQUESTS);
  assert.equal(resolveMaxParallelRequests(0), 1);
  assert.equal(resolveMaxParallelRequests(-3), 1);
  assert.equal(resolveMaxParallelRequests(3.9), 3);
  assert.equal(resolveMaxParallelRequests(7), GATEWAY_MAX_PARALLEL_REQUESTS);
  assert.equal(resolveMaxParallelRequests(40), GATEWAY_MAX_PARALLEL_REQUESTS);
});

test("credential ids are stable, opaque, and distinct per key", () => {
  const first = credentialId("sk-live-aaa");
  assert.equal(first, credentialId("sk-live-aaa"));
  assert.notEqual(first, credentialId("sk-live-bbb"));
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first.includes("sk-live-aaa"), false);
});

test("the registry keeps one queue per credential", async () => {
  const registry = new SlotQueueRegistry(1);
  const first = await registry.acquire("sk-live-aaa");
  const queued = registry.acquire("sk-live-aaa");
  // A second key gets its own slot instead of waiting behind the first key.
  const other = await registry.acquire("sk-live-bbb");
  assert.equal(other.waited, false);
  assert.equal(registry.queueCount, 2);

  first.release();
  const leased = await queued;
  assert.equal(leased.waited, true);
  leased.release();
  other.release();
});
