/**
 * Per-credential FIFO queue for the gateway's concurrency limit.
 *
 * NaN accepts at most {@link GATEWAY_MAX_PARALLEL_REQUESTS} concurrent requests
 * per API key, counting every endpoint. Requests beyond that limit wait here
 * instead of being sent and answered with 429. A request cancelled while it is
 * waiting leaves the queue without consuming a slot and without reaching the
 * gateway.
 *
 * Nothing here is timer based: an uncontended acquire takes the slot
 * synchronously, so a single request pays no queue latency at all.
 */

import { createHash } from "node:crypto";

/** Concurrent requests NaN documents per API key. */
export const GATEWAY_MAX_PARALLEL_REQUESTS = 7;
/** Default capacity: the documented gateway limit, not a conservative value. */
export const DEFAULT_MAX_PARALLEL_REQUESTS = GATEWAY_MAX_PARALLEL_REQUESTS;
/** A queue must always let one request through. */
export const MIN_PARALLEL_REQUESTS = 1;

/** Clamps `nanBuilders.maxParallelRequests` into an integer the gateway allows. */
export function resolveMaxParallelRequests(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_PARALLEL_REQUESTS;
  }
  return Math.min(
    GATEWAY_MAX_PARALLEL_REQUESTS,
    Math.max(MIN_PARALLEL_REQUESTS, Math.floor(value)),
  );
}

/**
 * Stable, non-reversible credential identifier used as the queue key. #120 can
 * replace it with a profile id; the queue never sees the secret as a map key.
 */
export function credentialId(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 16);
}

/** Rejection reason for a waiter cancelled before it received a slot. */
export class SlotQueueCancelledError extends Error {
  constructor() {
    super("Canceled while waiting for a free request slot.");
    // Matches the transport abort errors, so callers treat it as cancellation.
    this.name = "AbortError";
  }
}

/** An acquired slot. Releasing twice is a no-op, so `finally` is always safe. */
export interface SlotLease {
  /** True when the request had to wait in the queue before running. */
  readonly waited: boolean;
  release(): void;
}

interface Waiter {
  readonly resolve: (lease: SlotLease) => void;
  readonly reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * FIFO queue with a fixed number of slots.
 *
 * Capacity is read on every acquire and release, so changing
 * `nanBuilders.maxParallelRequests` applies without reloading the window.
 */
export class SlotQueue {
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private readonly capacitySource: () => number;

  constructor(capacity: number | (() => number)) {
    this.capacitySource = typeof capacity === "function" ? capacity : () => capacity;
  }

  get capacity(): number {
    return resolveMaxParallelRequests(this.capacitySource());
  }

  /** Slots currently held, including one handed over to a waiter. */
  get inUse(): number {
    return this.active;
  }

  /** Requests still waiting for a slot. */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * Resolves with a slot when one is available, or rejects with a
   * `SlotQueueCancelledError` if `signal` aborts first. A rejected acquire
   * never consumes a slot.
   */
  acquire(signal?: AbortSignal): Promise<SlotLease> {
    if (signal?.aborted) {
      return Promise.reject(new SlotQueueCancelledError());
    }
    // A capacity increase may have unblocked waiters before this call.
    this.drain();
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.createLease(false));
    }
    return new Promise<SlotLease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) {
            // The slot was already handed over; the holder releases it.
            return;
          }
          this.waiters.splice(index, 1);
          reject(new SlotQueueCancelledError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Applies a capacity change to waiters already parked in the queue. */
  refresh(): void {
    this.drain();
  }

  private createLease(waited: boolean): SlotLease {    let released = false;
    return {
      waited,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.releaseSlot();
      },
    };
  }

  private releaseSlot(): void {
    if (this.active === 0) {
      return;
    }
    this.active -= 1;
    this.drain();
  }

  /** Hands free slots to waiters in arrival order. */
  private drain(): void {
    const capacity = this.capacity;
    let waiter = this.waiters.shift();
    while (waiter && this.active < capacity) {
      this.detach(waiter);
      this.active += 1;
      waiter.resolve(this.createLease(true));
      waiter = this.waiters.shift();
    }
    if (waiter) {
      this.waiters.unshift(waiter);
    }
  }

  private detach(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.signal = undefined;
    waiter.onAbort = undefined;
  }
}

/**
 * One queue per resolved credential. #120 (multi-key profiles) passes its own
 * profile id to {@link forCredential}; nothing else needs to change.
 */
export class SlotQueueRegistry {
  private readonly queues = new Map<string, SlotQueue>();

  private readonly capacitySource: () => number;

  constructor(capacity: number | (() => number)) {
    this.capacitySource = typeof capacity === "function" ? capacity : () => capacity;
  }

  get queueCount(): number {
    return this.queues.size;
  }

  /** Queue for an opaque credential id, created on first use. */
  forCredential(id: string): SlotQueue {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = new SlotQueue(this.capacitySource);
      this.queues.set(id, queue);
    }
    return queue;
  }

  /**
   * Acquires a slot for `apiKey`'s queue. Only a fingerprint of the key is
   * retained, never the key itself.
   */
  acquire(apiKey: string, signal?: AbortSignal): Promise<SlotLease> {
    return this.forCredential(credentialId(apiKey)).acquire(signal);
  }

  /** Applies a capacity change to waiters already parked in every queue. */
  refresh(): void {
    for (const queue of this.queues.values()) {
      queue.refresh();
    }
  }
}
