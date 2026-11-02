# Validation checklist

This is the validation pass for the provider release. Unit tests cover the stream decoder, model catalog, tool-name mapping, request building and error sanitization, the usage API and pagination, quota catalog, local usage history, and status-bar/tooltip presentation. `npm run test:insiders` exercises discovery and streamed chat through the actual VS Code Insiders Language Model API using a local mock server; it does not use a real key. A separate live check against NaN is still required before Marketplace publication.

## Build

```bash
npm ci
npm run check
npm run test:coverage
npm run package
```

Expected: TypeScript compilation, `oxlint` lint, unit tests, and VSIX packaging all complete successfully. `npm run check` runs `clean → compile → lint → test:unit → test:insiders`.

## Unit-test coverage gate

`npm run test:coverage` measures compiled files under `src/` with c8; tests and generated output are excluded. It enforces a minimum of **58.99% total source line coverage**, the measured round-two baseline. The gate reads c8's `coverage/coverage-summary.json` and reports both measured and required percentages when it fails. Its unit test uses temporary summaries just above and below the floor to exercise both outcomes without changing generated coverage artifacts.

Raise the floor only after a new coverage report establishes a higher baseline and the corresponding test improvements are included. Keep the `src/` include and `test/` exclusion aligned with the documented source-only scope; do not lower the threshold to mask a regression.

## Automated VS Code integration

```bash
npm run test:insiders
```

Expected: the extension is loaded in an isolated Insiders profile, discovers the mock `glm5.3-flash` model, sends a streamed request through `vscode.lm.selectChatModels` / `sendRequest`, and receives `NAN_OK`. No real NaN credential or network request is used.

## Provider registration

1. Install the generated VSIX in current stable VS Code.
2. Open **Chat: Manage Language Models**.
3. Confirm **NaN Builders** appears as a provider.
4. Open Extensions and search `@tag:language-models`.
5. Confirm the installed extension is classified as a language model provider.

## Credentials and model list

1. Run **NaN Builders: Manage Provider**.
2. Enter an invalid key and confirm validation reports a clear authentication error.
3. Enter a valid `sk-...` key.
4. Confirm the key is not written to `settings.json`, `chatLanguageModels.json`, the workspace, or extension logs.
5. Compare the picker with `GET /v1/models` for the same key. Every known chat ID returned there should be offered: `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.8-flash`, `mimo-v2.6-flash`, `gemma4`, `qwen3.6`, and, for premium keys, `glm5.3`. Models absent from `/v1/models` must stay absent from the picker.
6. Confirm known non-chat IDs such as embeddings, rerank, audio, and image generation are not exposed as chat models.

Important: treat `/v1/models` as the definitive API-key-filtered list. A model must not be exposed just because it exists in the local metadata catalog. In particular, `glm5.3` should only appear for keys whose `/v1/models` response contains it.

## Basic streaming chat

Run a short prompt with `deepseek-v4-flash`:

```text
Reply with exactly: NAN_OK
```

Expected: text appears progressively and finishes with `NAN_OK`.

Repeat with `glm5.3-flash`.

## Upstream response size limits

Successful JSON responses from model discovery, usage, and inline completion are limited to **5 MiB**. JSON error bodies and chat error text are limited to **64 KiB**. Limits count bytes read from the Fetch response stream, and streamed bodies are canceled as soon as they exceed the limit. Oversize failures use a stable message and never include response content.

Unit tests cover an exactly-at-limit body, streamed over-limit bodies, cancellation/release, multibyte decoding across chunks, and each API surface. These caps apply to response bodies only; request payload limits and successful chat SSE buffer limits are separate concerns.

## Agent tool calling

Select `glm5.3-flash` in Agent mode in a disposable test repository and ask:

```text
Create a file named nan-provider-smoke.txt containing the single line NAN_TOOL_OK, then read it back and tell me its contents.
```

Expected:

- VS Code offers the filesystem/tool calls normally.
- NaN returns one or more tool calls.
- The extension reconstructs streamed tool-call arguments.
- Tool names map back to the original VS Code names.
- The agent continues after tool results.
- The file contains exactly `NAN_TOOL_OK`.

Delete the test file afterwards.

## Vision

With `deepseek-v4-flash`, attach a simple image and ask for a one-sentence description.

Expected: the request succeeds and the model describes the image. Repeat with `glm5.3` and confirm VS Code does not offer image input for that model.

## Cancellation

Start a long request and cancel it from Chat.

Expected: the HTTP stream is aborted and no further text or tool calls appear.

## Usage

Make at least one request from VS Code.

Expected: the status bar shows `NaN` and local token usage when the API returns streaming usage metadata. The tooltip must state that this is local VS Code session usage, not the account-wide NaN quota.

## Account-wide usage API

With a valid key configured, run **NaN Builders: Show Usage** and refresh.

Expected:

- The status bar headline becomes `$(graph) NaN NN%`, the most restricted monthly quota percentage in use this month, read from `GET /v1/usage`.
- The tooltip shows the served window (`start_date → end_date`), window totals, all-time totals with their cache timestamp, per-model rows, and the daily API-request cutoff date.
- Percentages appear only for models with a documented fixed monthly counter. `qwen3.6` and `gemma4` show "No token counter"; `glm5.3` shows its billing-period quota note. No percentage is fabricated.
- A failed refresh keeps the previous snapshot and adds a "Last refresh failed" line; a 429 shows its `Retry-After` hint.
- Automatic refreshes are throttled (60s between refreshes, 30 requests/minute limiter); a manual refresh bypasses the throttle.
- A stalled usage refresh times out after 30 seconds, aborts the request, keeps the last good snapshot, and clears its loading state.
- Without a key, the status bar and command fall back to local session usage and the tooltip says account usage is unavailable.

## Quotas

Open **NaN Builders: Show Usage** and inspect the quota rows.

Expected:

- Every known chat model appears with its documented cap (`3B per month`, `2B per month`, `500M per month`, `1B per month`, or the `glm5.3` billing-period/rolling note).
- Models with no published limit say "No published quota limit"; models with no token counter say "No token counter".
- Local usage per model is labelled as observed by this VS Code extension this session, never as account-wide usage or remaining quota.

## Local usage history

Make a few requests, then reopen **NaN Builders: Show Usage**.

Expected:

- Per-model daily aggregates (UTC days) appear for the last 30 days, capped at 1,000 model/day records.
- Corrupted or expired stored records are discarded on load instead of breaking the status bar.
- **Clear local history** empties the history and resets the session counters.
- Only counts and model IDs are stored in extension storage — never prompts, completions, API keys, or request payloads.

## Inline completions

Set `nanBuilders.completionModel` to a model ID returned by `/v1/models` and open a file-scheme document.

Expected:

- Ghost text appears after a pause while typing; each suggestion is one `POST {apiBaseUrl}/completions` request carrying only the last 4,000 characters before the cursor, capped at 64 completion tokens and 1,000 suggestion characters.
- Continuing to type aborts the in-flight request and no stale suggestion appears.
- HTTP errors, network failures, and empty or malformed responses never surface stale text.
- With `nanBuilders.completionModel` unset, no inline provider is registered and no extra requests are sent.
- Note: while enabled, each pause can send an extra billed request that local usage history does not count yet (see [issue #7](https://github.com/svg153/nan-vscode/issues/7)).

## Remote and WSL behavior

Open a WSL workspace with the extension installed locally.

Expected: the provider remains available without requiring a second installation inside WSL, because the extension is declared as a UI extension.

## Exit criteria

The release is ready for a tagged pre-release when all checks above pass on current stable VS Code and no API key or session secret appears in logs or workspace files.
