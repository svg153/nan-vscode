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

## GitHub Actions pin updates

Workflow actions are pinned to full commit SHAs, with the corresponding release tag in a trailing comment. Dependabot checks the GitHub Actions ecosystem weekly and opens reviewable update pull requests. For each update, verify the SHA against the action's upstream release/tag, update the version comment, inspect release notes and the workflow diff (permissions, inputs, artifact paths/retention, and release behavior), then require the pull-request CI checks before merging. Do not broaden workflow permissions or alter secret use as part of a routine pin update.

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
5. Compare the picker with `GET /v1/models` for the same key. Every known chat ID returned there should be offered: `deepseek-v4-flash`, `deepseek-v4-pro`, `glm5.3-flash`, `qwen3.8-flash`, `qwen3.8-max`, `qwen4-max`, `mimo-v2.6-flash`, `kimi-k3.1-pro`, `hy4`, `hy4-flash`, `gemma4`, `qwen3.6`, and, for keys with access, `glm5.3`. Models absent from `/v1/models` must stay absent from the picker.
6. Confirm known non-chat IDs such as embeddings, rerank, audio, and image generation are not exposed as chat models.

Important: treat `/v1/models` as the definitive API-key-filtered list. A model must not be exposed just because it exists in the local metadata catalog. In particular, the larger models (`glm5.3`, `kimi-k3.1-pro`, `qwen3.8-max`, `qwen4-max`, `deepseek-v4-pro`, `hy4`) should only appear for keys whose `/v1/models` response contains them.

## API key profiles

1. Run **NaN Builders: Manage Provider** and confirm the profile actions appear
   only after a first API key exists, and that they never print a key.
2. Add profiles `work` and `personal`, set a different mock key for each,
   and set the active profile to `personal`.
3. Assign `glm5.3` to `work` from the provider management flow and confirm
   `nanBuilders.reasoningEffortByModel` gains a `work::glm5.3` entry.
4. Send one message to `glm5.3` and one to another model. The first request
   must carry the `work` key and the second the `personal` key (check the
   gateway logs for the key suffix only, never the full key).
5. Clear the active profile key and confirm the next request fails before any
   gateway call with a message naming the profile.
6. Delete `work` and confirm its SecretStorage entry disappears, its
   `work::model` overrides are removed, and `glm5.3` falls back to the
   active profile.
7. **NaN Builders: Show Diagnostics** must list profile IDs and `key: set` /
   `key: missing` only. No SecretStorage value may appear in diagnostics,
   `settings.json`, or the extension log.
8. With no profiles configured, the legacy `nanBuilders.apiKey` keeps working
   unchanged; no migration prompt appears.

## Basic streaming chat

Run a short prompt with `deepseek-v4-flash`:

```text
Reply with exactly: NAN_OK
```

Expected: text appears progressively and finishes with `NAN_OK`.

Repeat with `glm5.3-flash`.

## Upstream response size limits

Successful JSON responses from model discovery, usage, and inline completion are limited to **5 MiB**. JSON error bodies and chat error text are limited to **64 KiB**. Limits count bytes read from the Fetch response stream, and streamed bodies are canceled as soon as they exceed the limit. Oversize failures use a stable message and never include response content.

Unit tests cover an exactly-at-limit body, streamed over-limit bodies, cancellation/release, multibyte decoding across chunks, and each API surface. These caps apply to HTTP response bodies only; request payload limits and successful chat SSE buffers are bounded separately below.

## Chat stream buffer limits

The chat SSE decoder accepts a maximum line of **1,048,576 UTF-16 code units**. Each tool call is limited to **262,144 code units** of accumulated arguments and **256 code units** each for its ID and name; at most **128** tool calls can be buffered at once. Exceeding any cap raises a stable error, clears partial tool-call state, and cancels the upstream stream. A line without a delimiter is rejected as soon as its buffer crosses the line cap.

Unit tests exercise exact and over-limit boundaries, a missing newline across chunks, partial tool-call suppression, and upstream cancellation. Normal SSE text, usage metadata, and tool calls below the limits retain their existing behavior.

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

## Chat request timeouts

Chat requests run two independent timers instead of one overall deadline:

| Setting | Default | Meaning |
| --- | --- | --- |
| `nanBuilders.connectTimeoutSeconds` | `20` | Deadline for the response headers of a chat request. |
| `nanBuilders.streamIdleTimeoutSeconds` | `120` | Maximum silence between streamed chunks; the timer restarts on every chunk. |

Expected: a slow stream that keeps emitting chunks is never aborted, regardless of total duration. A gateway that accepts the connection and never sends headers fails after `connectTimeoutSeconds` with a timeout error, and a stream that stays silent for `streamIdleTimeoutSeconds` is aborted, its slot is released, and the error message names the corresponding setting. Canceling the request from Chat still reports cancellation rather than a timeout, and no timer survives the request.

Unit tests use a fake clock to cover re-arming on chunks, firing on silence, firing on missing headers, and clearing both timers on cancellation.

## Transparent retries

| Setting | Default | Meaning |
| --- | --- | --- |
| `nanBuilders.maxRetries` | `2` | Extra attempts for a retryable failure that happens before the stream starts. `0` disables retries. |

Temporarily point `nanBuilders.apiBaseUrl` at a stub that answers the first request with `429` and a `Retry-After: 1` header, then streams normally.

Expected: the reply arrives after a visible pause of about one second, the Output channel logs one `chat.retry` diagnostic naming the model, attempt, wait and error code, and the request is counted once in the queue rather than holding a slot during the wait. Canceling from Chat during the pause stops the retry immediately and releases the slot. With `maxRetries: 0` the same stub shows the throttle error instead of retrying, and the error still triggers `nanBuilders.failoverOnThrottle` when that is enabled.

Unit tests use a fake clock to cover a `Retry-After` wait, backoff doubling with jitter, the 8 s cap, exhausted retries reporting the mapped error, an `insufficient_quota` 429 that is never retried, cancellation during the wait, and the retry-before-failover ordering.

## Cancellation

Start a long request and cancel it from Chat.

Expected: the HTTP stream is aborted and no further text or tool calls appear.

## Usage

Make at least one request from VS Code.

Expected: the status bar shows `NaN` and local token usage when the API returns streaming usage metadata. The tooltip must state that this is local VS Code session usage, not the account-wide NaN credit balance.

## Experimental native Chat token usage (VS Code 1.146+)

The setting `nanBuilders.experimentalNativeChatUsage` defaults to `false`. It
uses the **undocumented** `LanguageModelDataPart` with MIME type `usage`
observed in microsoft/vscode#317187. It is not a stable API contract and must
not be enabled by default without an explicit maintainer decision.

1. With the setting off, send a prompt; verify local usage history and the
   status bar are unchanged and no experimental usage part is emitted.
2. On VS Code Insiders 1.146+, enable the setting. With a real provider response
   that reports non-estimated token counts, check native Chat usage is non-zero.
   Record editor version, extension version and harness (Local versus Copilot
   Agent Host); test both separately. A successful raw LM stream test does **not**
   establish that the Chat UI or Agent Host consumes the part correctly.
3. Run `npm run test:insiders` with its mock gateway (no real NaN key). It
   checks the raw usage data part when available, that a request retried after a
   pre-stream throttle still reports exactly one part for the settled turn, and
   normal local persistence.
4. Test a response without a `usage` chunk, cancelled streams, NaN
   reasoning-only truncation and malformed counts: none should produce a
   misleading native success token count.
5. Confirm older VS Code versions remain functional with the opt-in feature
   skipped, and that experimental part failures never fail a chat request.
6. With `nanBuilders.maxRetries` and `nanBuilders.failoverOnThrottle` enabled,
   verify a retried or failed-over request reports native usage **once**, for the
   attempt that finally served it: never once per attempt, and never for an
   attempt that failed, was cancelled or was truncated.

Do not infer cached input or reasoning tokens from prompt/completion counts.
Agent Host cache forwarding is separately tracked by microsoft/vscode#348390.
The account-wide **credits** view is a different metric and must not change.

Upstream: [issue #317187](https://github.com/microsoft/vscode/issues/317187),
[typed API proposal #319686](https://github.com/microsoft/vscode/pull/319686),
[alternative proposal #320550](https://github.com/microsoft/vscode/pull/320550).

## Account-wide usage API

With a valid key configured, run **NaN Builders: Show Usage** and refresh.

Expected:

- The status bar headline becomes `$(graph) NaN NN%`, the share of the plan's credit allowance used this period, read from `GET /v1/usage`. When the same snapshot reports `credits.frozen: true` the headline becomes `$(warning) NaN frozen` instead, because credit-billed requests are being refused; clearing the freeze restores the percentage on the next refresh.
- The tooltip shows the served window (`start_date → end_date`), window totals, all-time totals with their cache timestamp, per-model rows, the plan-credit and credit-pack lines, and the API cutoff dates.
- Window totals and per-model rows show the cached input tokens NaN reports (from 2026-11-11 onward) as a share of the prompt count, never added to the token total.
- The plan-credit line ends with the billing period range (`period_start → period_end`) when the API reports one, or `renews <date>` otherwise; a frozen plan shows the frozen warning and the QuickPick label `$(warning) Plan credits (frozen)`.
- The credit-pack line renders `pack_expires_at` as a readable date with the distance in days ("expires 2026-06-01 (in 12 days)", "expires today", "expired on 2026-05-01"), never as a raw ISO timestamp.
- The QuickPick includes a `$(credit-card) Window credits (calendar month)` row whose detail states that the sum of the rounded per-model rows is approximate and can differ from the billing-period used total by tenths.
- The QuickPick ends with an **Open** section of four rows, each opening in the external browser, not inside VS Code: `Open API keys` → `https://cloud.nan.builders/#settings-api-keys`, `Open model docs` → `https://nan.builders/docs/models`, `Open billing & credit packs` → `https://cloud.nan.builders/#settings-billing`, and `Open credits per 1M tokens` → `https://cloud.nan.builders/tokens`.
- In the model picker, every NaN entry's tooltip ends with a billing line: `Billing: credits from the account-wide pool shared with every other NaN model`, or for the larger models `Billing: credits, larger model - it costs more per token than the flash models, so it uses credits faster.` under the `(larger model)` name suffix.
- Percentages appear only when the API reports a plan allowance and the model billed credits in the window. `qwen3.6` and `gemma4` say "Does not draw credits"; no percentage is fabricated.
- A failed refresh keeps the previous snapshot and adds a "Last refresh failed" line; a 429 shows its `Retry-After` hint.
- Automatic refreshes are throttled (60s between refreshes, 30 requests/minute limiter); a manual refresh bypasses the throttle.
- A stalled usage refresh times out after 30 seconds, aborts the request, keeps the last good snapshot, and clears its loading state.
- Without a key, the status bar and command fall back to local session usage and the tooltip says account usage is unavailable.

## Credits and billing posture

Open **NaN Builders: Show Usage** and inspect the model rows.

Expected:

- Every known chat model lists its billing posture (`Paid from plan credits` or `Does not draw credits` for unmetered models) plus the local usage this session observed.
- Models with no documented allowance say `Billed in credits; no documented allowance`.
- Per-model credit usage counts only requests billed in credits (from 2026-11-10 onward); cached input tokens are only reported from 2026-11-11.
- Local usage per model is labelled as observed by this VS Code extension this session, never as account-wide usage or remaining balance.

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

## Credits refused (HTTP 402)

Exhaust the plan allowance (or freeze the subscription) and send a chat turn.

Expected: the error reads `NaN Builders API error 402 … — <reason>` where the reason names the single credits pool, frozen credits, or the missing pack, and points at **NaN Builders: Show Usage**. The body never echoes the API key, and non-402 errors keep their previous wording.

## Remote and WSL behavior

Open a WSL workspace with the extension installed locally.

Expected: the provider remains available without requiring a second installation inside WSL, because the extension is declared as a UI extension.

## Auto-discovery mode

`nanBuilders.discoveryMode: auto` mirrors the Copilot custom-endpoint behavior for trusted OpenAI-compatible servers: all IDs from `GET /models` are offered except the non-chat denylist, obvious non-chat name patterns (`embedding`, `rerank`, `whisper`, `tts`, `image`, `flux`, `video`, `guard`, `speech`, `transcri…`, `asr`, `moderation`, `minimax`), and entries explicitly marked non-chat. Explicit endpoint metadata (`is_chat`, chat `model_type`) takes precedence over the name heuristics, so a model named like a non-chat family but marked chat stays listed. Capability fields returned by the endpoint override the conservative defaults; unknown models without declared capabilities stay without tool calling or vision. `curated` (the default) keeps the previous catalog-first behavior. In `curated` mode, when `GET /models` fails or returns no usable chat IDs, the picker falls back to the static NaN Builders catalog; each fallback entry is marked "not live-verified" in its detail and tooltip and the result is not cached, so the next request retries live discovery. `auto` mode never substitutes the static catalog because it would misrepresent third-party endpoints. Every discovered model gets an input budget of `max(1, min(context − max_output, 0.9 × context))` tokens. The remote-HTTP consent guard applies unchanged, so an API key is never sent to an unconfirmed `http:` endpoint.

## Exit criteria

The release is ready for a tagged pre-release when all checks above pass on current stable VS Code and no API key or session secret appears in logs or workspace files.
