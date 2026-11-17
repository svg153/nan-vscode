import assert from "node:assert/strict";
import test from "node:test";
import { RequestTimeoutError } from "../src/openai/request";
import {
  ChatTimeoutController,
  DEFAULT_CHAT_TIMEOUTS,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  resolveTimeoutSeconds,
  type ChatTimeouts,
} from "../src/openai/timeouts";

const TIMEOUTS: ChatTimeouts = { connectTimeoutSeconds: 20, streamIdleTimeoutSeconds: 120 };

function controllerFor(aborts: RequestTimeoutError[], timeouts: ChatTimeouts = TIMEOUTS): ChatTimeoutController {
  return new ChatTimeoutController(timeouts, (reason) => {
    aborts.push(reason);
  });
}

test("connect timeout fires when response headers never arrive", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts);

  controller.armConnect();
  t.mock.timers.tick(19_999);
  assert.equal(aborts.length, 0);

  t.mock.timers.tick(1);
  assert.equal(controller.timeoutError?.kind, "connect");
  assert.equal(controller.timeoutError?.timeoutSeconds, DEFAULT_CONNECT_TIMEOUT_SECONDS);
  assert.equal(aborts.length, 1);
  assert.match(aborts[0].message, /did not send response headers within 20 seconds/);
});

test("connect timeout is cleared once response headers arrive", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts);

  controller.armConnect();
  t.mock.timers.tick(5_000);
  controller.startStream();
  t.mock.timers.tick(20_000);

  assert.equal(aborts.length, 0);
  assert.equal(controller.timeoutError, undefined);
});

test("a slow but alive stream is never aborted while chunks keep arriving", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts);

  controller.armConnect();
  controller.startStream();
  // Ten minutes of a stream that sends a chunk every 60 seconds, half the
  // 120-second idle deadline.
  for (let minute = 0; minute < 10; minute += 1) {
    t.mock.timers.tick(60_000);
    controller.touch();
    assert.equal(aborts.length, 0);
  }
  t.mock.timers.tick(119_999);
  assert.equal(aborts.length, 0);
  controller.settle();
});

test("stream idle timeout fires after prolonged silence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts);

  controller.startStream();
  t.mock.timers.tick(119_999);
  assert.equal(aborts.length, 0);

  t.mock.timers.tick(1);
  assert.equal(controller.timeoutError?.kind, "stream-idle");
  assert.equal(controller.timeoutError?.timeoutSeconds, DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS);
  assert.equal(aborts.length, 1);
  assert.match(aborts[0].message, /no stream data for 120 seconds/);

  // A timeout stops all further timing; late chunks cannot re-arm it.
  controller.touch();
  t.mock.timers.tick(120_000);
  assert.equal(aborts.length, 1);
});

test("settle clears both timers on cancellation and ignores late callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts);

  controller.armConnect();
  controller.settle();
  t.mock.timers.tick(20_000);
  assert.equal(aborts.length, 0);

  const streaming = controllerFor(aborts);
  streaming.startStream();
  streaming.settle();
  t.mock.timers.tick(120_000);
  assert.equal(aborts.length, 0);
  assert.equal(streaming.timeoutError, undefined);
});

test("does not start timers after settle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts);

  controller.settle();
  controller.armConnect();
  controller.startStream();
  controller.touch();
  t.mock.timers.tick(MAX_TIMEOUT_SECONDS * 1000);
  assert.equal(aborts.length, 0);
});

test("arming a new connect deadline clears the previous body idle timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const aborts: RequestTimeoutError[] = [];
  const controller = controllerFor(aborts, { connectTimeoutSeconds: 20, streamIdleTimeoutSeconds: 10 });

  controller.armConnect();
  controller.startStream();
  t.mock.timers.tick(5_000);
  // A fallback HTTP send starts: the leftover body timer must not fire.
  controller.armConnect();
  t.mock.timers.tick(10_000);
  assert.equal(aborts.length, 0);
  const beforeConnectDeadline = controller.timeoutError;
  assert.equal(beforeConnectDeadline, undefined);

  t.mock.timers.tick(10_000);
  assert.equal(controller.timeoutError?.kind, "connect");
  assert.equal(aborts.length, 1);
});

test("resolveTimeoutSeconds keeps whole seconds within the supported range", () => {
  assert.equal(resolveTimeoutSeconds(undefined, DEFAULT_CONNECT_TIMEOUT_SECONDS), DEFAULT_CONNECT_TIMEOUT_SECONDS);
  assert.equal(resolveTimeoutSeconds(Number.NaN, DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS), DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS);
  assert.equal(resolveTimeoutSeconds("60", 20), 20);
  assert.equal(resolveTimeoutSeconds(0, 20), MIN_TIMEOUT_SECONDS);
  assert.equal(resolveTimeoutSeconds(-5, 20), MIN_TIMEOUT_SECONDS);
  assert.equal(resolveTimeoutSeconds(12.9, 20), 12);
  assert.equal(resolveTimeoutSeconds(MAX_TIMEOUT_SECONDS + 100, 20), MAX_TIMEOUT_SECONDS);
  assert.deepEqual(DEFAULT_CHAT_TIMEOUTS, {
    connectTimeoutSeconds: 20,
    streamIdleTimeoutSeconds: 120,
  });
});
