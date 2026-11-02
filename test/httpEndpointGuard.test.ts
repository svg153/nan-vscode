import assert from "node:assert/strict";
import test from "node:test";
import { HttpEndpointGuard, remoteHttpEndpoint } from "../src/httpEndpointGuard";

test("remoteHttpEndpoint requires confirmation only for non-loopback HTTP", () => {
  for (const endpoint of [
    "https://api.example.test/v1",
    "http://localhost:3000/v1",
    "http://localhost.:3000/v1",
    "http://service.localhost:3000/v1",
    "http://127.0.0.1:3000/v1",
    "http://127.8.9.10:3000/v1",
    "http://[::1]:3000/v1",
    "http://[0:0:0:0:0:0:0:1]:3000/v1",
    "http://[::ffff:127.0.0.1]:3000/v1",
    "http://[0:0:0:0:0:ffff:7f00:1]:3000/v1",
  ]) {
    assert.equal(remoteHttpEndpoint(endpoint), undefined, endpoint);
  }

  assert.equal(remoteHttpEndpoint("http://api.example.test:3000/v1"), "http://api.example.test:3000/v1");
  assert.equal(remoteHttpEndpoint("http://127.0.0.1.example.test/v1"), "http://127.0.0.1.example.test/v1");
});

test("remoteHttpEndpoint omits credentials, query, fragments, and trailing slashes", () => {
  assert.equal(
    remoteHttpEndpoint("http://user:password@api.example.test/v1///?token=secret#fragment"),
    "http://api.example.test/v1",
  );
});

test("HttpEndpointGuard remembers approval and de-duplicates concurrent prompts", async () => {
  let promptCount = 0;
  let resolvePrompt!: (approved: boolean) => void;
  const prompt = new Promise<boolean>((resolve) => {
    resolvePrompt = resolve;
  });
  const guard = new HttpEndpointGuard(async (endpoint) => {
    promptCount += 1;
    assert.equal(endpoint, "http://api.example.test/v1");
    return prompt;
  });

  const first = guard.authorize("http://api.example.test/v1");
  const second = guard.authorize("http://api.example.test/v1///");
  assert.equal(promptCount, 1);
  resolvePrompt(true);
  await Promise.all([first, second]);
  await guard.authorize("http://api.example.test/v1");
  assert.equal(promptCount, 1);
});

test("HttpEndpointGuard rejects canceled confirmation and allows a later retry", async () => {
  let promptCount = 0;
  const guard = new HttpEndpointGuard(async () => {
    promptCount += 1;
    return promptCount > 1;
  });

  await assert.rejects(guard.authorize("http://api.example.test/v1"), (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
  );
  await guard.authorize("http://api.example.test/v1");
  assert.equal(promptCount, 2);
});

test("HttpEndpointGuard does not prompt for an already-aborted request", async () => {
  let promptCount = 0;
  const guard = new HttpEndpointGuard(async () => {
    promptCount += 1;
    return true;
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(guard.authorize("http://api.example.test/v1", controller.signal), (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
  );
  assert.equal(promptCount, 0);
});
