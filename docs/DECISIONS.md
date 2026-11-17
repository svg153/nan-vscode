# Product and implementation decisions

The marker `AUTONOMOUS-DECISION` is used for decisions made during implementation that are useful to revisit later.

## AUTONOMOUS-DECISION: native provider, not a second chat UI

**Question:** Should the extension build its own webview/chat experience or integrate with VS Code Chat?

**Options:**

- Build a custom chat UI.
- Register a native `LanguageModelChatProvider`.

**Research:** Current VS Code exposes the stable `languageModelChatProviders` contribution point and `vscode.lm.registerLanguageModelChatProvider`. Hugging Face already uses this architecture in its public provider extension.

**Decision:** Use the native provider API. This is the feature that makes the extension appear with other language model providers and allows Agent mode to use NaN models.

## AUTONOMOUS-DECISION: `/v1/models` is authoritative for availability

**Question:** Should the extension expose every documented chat model, or only those returned for the configured API key?

**Options:**

- Always expose the whole documented catalog and let requests fail if the key lacks access.
- Use `/v1/models` as the availability list and the local catalog only for VS Code capability metadata.

**Research:** Current NaN documentation says `/v1/models` is the definitive list, filtered by what the API key can actually call. This matters for `glm5.3`, which requires the premium tier. VS Code still needs context, output, image, and tool-calling metadata that the endpoint does not currently provide.

**Decision:** Only expose IDs returned by `/v1/models`. Use the local catalog to enrich known chat IDs. Filter known non-chat endpoints. Hide unknown IDs by default because a future non-chat model must not be misclassified as chat; users can opt in to unknown IDs, which are then exposed without tool calling or vision.

**Follow-up:** If NaN later includes capability/type metadata in `/v1/models`, remove most of the local catalog and derive the picker directly from the server response.

## AUTONOMOUS-DECISION: use SecretStorage

**Question:** Where should the NaN API key live?

**Options:**

- VS Code settings.
- A local config file.
- VS Code `SecretStorage`.

**Decision:** Use `SecretStorage`. The key must not be written to the workspace or settings JSON.

## AUTONOMOUS-DECISION: do not reuse the nan-cli web session

**Question:** How should the first release show usage?

**Options:**

- Read browser cookies or the `nan-cli` session file and call the cloud account endpoint.
- Implement a second NaN account login flow in the extension.
- Show request usage returned by the OpenAI-compatible API and wait for a key-authenticated account usage endpoint.

**Research:** Account-wide usage currently comes from a separate cloud endpoint authenticated with the NaN web session, while inference uses the API key. Coupling the extension to browser cookies or `nan-cli` would make installation less self-contained and expand credential handling.

**Decision (MVP):** The MVP shows local VS Code session usage from streamed API usage metadata. Account-wide usage is deferred until there is a clean key-authenticated API or a separately reviewed account-login feature.

**Update — account-wide usage shipped:** NaN Builders now exposes a key-authenticated `GET /v1/usage` endpoint, so the deferral above is resolved without cookies or a second login flow. `src/accountUsage.ts` implements it:

- `AccountUsageService` fetches the current-month window with the configured API key, keeps the last successful snapshot, and records `lastError` instead of hiding stale-but-real data when a refresh fails.
- The status bar headline is the share of the plan's credit allowance used this period (`$(graph) NaN NN%`), never a sum across models; without a snapshot it falls back to the compact local session total.
- The tooltip and **NaN Builders: Show Usage** render window totals, all-time totals, per-model rows with credit usage and its share of the plan allowance, and the API cutoff dates.
- Refreshes are throttled client-side (60s between automatic refreshes plus a 30 requests/minute limiter); a 429 surfaces its `Retry-After` hint.
- Per-model percentages are only rendered when a plan allowance is known and the model billed credits in the window; models that never draw credits (`qwen3.6`, `gemma4`, embeddings, rerank, audio, image) say so instead of showing a fabricated percentage.
- NaN replaced per-model monthly token quotas with one credits pool on 2026-11-10 (`7,000` credits on Inference, `20,000` on Premium, then optional credit packs), reported as `credits` on `GET /v1/usage`. The extension reads that block and treats it as absent when the API omits it, so older responses still render.

**Still deferred:** reading browser cookies or the `nan-cli` session file, and any second NaN account login flow inside the extension. Account-wide usage stays API-key-only, and local session usage remains the fallback whenever no key is configured or the endpoint fails.

## AUTONOMOUS-DECISION: credits UI parity items from a sibling project

**Question:** A review of `SrScorpio/nan-bridge` (a competing client for the same credits API) listed five gaps in this extension's usage surface. Which should be adopted, and how far?

**Options:**

- Copy the competitor's presentation wholesale, including its own account UI.
- Adopt only the parts that make the API's own fields readable, staying inside VS Code's native surfaces.

**Research:** The gaps were: `credits.frozen` not surfaced, `pack_expires_at` shown as a raw timestamp, summed credit totals drifting by float error, no calendar-month breakdown, and no way to reach the console or the model catalogue from the dialog.

**Decision:** Adopt them natively; no second account UI.

- `frozen` is surfaced in the status bar (`$(warning) NaN frozen`, replacing the percentage because requests are being refused), the tooltip and the QuickPick (the latter two shipped earlier in `41d8c4a`).
- `pack_expires_at` renders as a date plus distance in days, with today/tomorrow/expired wording; unparsable values pass through instead of being dropped.
- Credit sums go through `sumCredits`, which filters non-finite values and rounds once to one decimal, matching NaN's own precision.
- The calendar-month breakdown is exposed as a separate **Window credits (calendar month)** row, explicitly labelled approximate. It never replaces the headline, because NaN rounds rows and model aggregates independently, so the sum can differ from `credits.used` by tenths.
- **Show Usage** ends with an **Open** section deep-linking to `#settings-api-keys` and `#settings-billing` on NaN Cloud, to `cloud.nan.builders/tokens` for the per-1M-token prices, and to the model catalogue, using `vscode.env.openExternal` rather than embedding a webview.
- The console is a TanStack Router SPA that only accepts hashes shaped `settings-<section>`; both `#settings-*` targets and the `/tokens` route were checked against the shipped bundle's route table (`account`, `api-keys`, `tokens`, `secrets`, `notifications`, `ephemeral`, `billing`, …) so no link is shipped unverified.
- A 402 from any endpoint appends the applicable credit reason and points at **Show Usage**, so an exhausted allowance is not reported as an opaque status code.

**Non-goal:** mirroring the competitor's standalone dashboard, its own billing charts, or any flow that would need NaN credentials beyond the stored API key.

## AUTONOMOUS-DECISION: Marketplace branding remains community-scoped

**Question:** Should the first package present itself as an official NaN Builders extension?

**Decision:** No. The code can use the descriptive name `NaN Builders for VS Code`, but documentation states that it is community-maintained unless NaN Builders explicitly adopts or publishes it. Marketplace publisher ownership and official branding need explicit agreement before public release.

## AUTONOMOUS-DECISION: gateway errors map to a shared taxonomy

**Question:** Should each call site format its own error text, or should HTTP statuses and transport failures go through one mapping?

**Options:**

- Keep per-call messages (the 402 hint shipped in `src/openai/request.ts`).
- Add a pure `ProviderErrorCode` taxonomy that every chat failure goes through.

**Decision:** One pure mapping in `src/providerErrors.ts`, used by the chat request path.

| Signal | Code | Message points at | Retryable |
| --- | --- | --- | --- |
| 401 | `invalid_api_key` | Update the key with **NaN Builders: Manage Provider**. | No |
| 403 | `invalid_api_key` | Update the key, or ask the key owner for model access. | No |
| 402, or 429 with `insufficient_quota` / `insufficient_balance` | `insufficient_quota` | One credits pool: spent allowance, frozen credits, or no active pack; **Show Usage**. | No |
| 404, or `model_not_found` / `no_such_model` | `model_not_found` | **NaN Builders: Refresh Models**, or check `nanBuilders.apiBaseUrl`. | No |
| `context_length_exceeded` / `prompt_too_long` | `context_length_exceeded` | Trim the chat history or start a new chat. | No |
| 408, 504, `TimeoutError`, `ProviderTimeoutError` | `timeout` | Retry, or check the network if it persists. | Yes |
| 429 without a quota code | `rate_limit_exceeded` | Wait, citing `Retry-After` seconds when the response carries them. | Yes |
| 5xx | `gateway_error` | Retry shortly, or try another model. | Yes |
| `TypeError` from `fetch`, `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET` | `network` | Check the network and `nanBuilders.apiBaseUrl`. | Yes |
| Abort without a timeout | `cancelled` | The request was cancelled. | No |
| Anything else | `unknown` | The existing sanitized body summary, or a generic failure. | No |

Details:

- The status wins for 401/403 and 402, because a key that cannot authenticate or a billing refusal is never a throttle or a model problem. Everywhere else `error.code` / `error.type` / `error.param` from the JSON body takes precedence over the bare status, and a specific `code` wins over a broader `type`, so a 429 whose body pairs `type: rate_limit_exceeded` with `code: insufficient_quota` points at **Show Usage** instead of a wait.
- `httpError` attaches the typed `ProviderError` (code + retryability) and accepts the parsed `Retry-After` value. `parseRetryAfter` now lives in the taxonomy module and is re-exported from `src/usageApi.ts`.
- Timeouts are never reported as cancellations. Issue #113 can throw `ProviderTimeoutError` from the connect or stream-idle timers; `toProviderError` turns it into the timeout message, and the mapper also recognizes `name === "TimeoutError"` and `code === "timeout"` so the hook stays usable before #113 lands.
- Every message that includes upstream text goes through `sanitizeErrorBody`, which keeps only structural `type`/`code`/`param` fields, redacts `sk-...` and `Bearer ...` tokens, bounds each field and the summary, and drops free-form messages. Request headers, the API key, and the full endpoint URL are never interpolated.

**Non-goals:** automatic retries or backoff, message localization, and changes to the streaming protocol.

## AUTONOMOUS-DECISION: agentic workflows stay on Copilot with explicit budget caps

**Question:** Should the two agentic workflows keep running on the Copilot engine with the GitHub-hosted runner, or move to a self-managed model provider, and does a public repository make either free?

**Options:**

- Keep Copilot and add explicit cost caps.
- Move `feature-scout` to the NaN Builders gateway with `engine: codex` and a NaN API key stored as a repository secret.
- Keep Copilot where the repository is public and free to run, and route the private copies through the NaN gateway so the spend lands on the NaN account instead of Copilot AI Credits.

**Research:** GitHub's billing documentation separates the two costs. Standard GitHub-hosted runners are free for public repositories and draw from included compute usage (~$0.006/min on Linux) for private ones. Inference is not free for public repositories: Copilot usage is billed in AI Credits (1 AIC = $0.01) against the plan or organization allowance regardless of visibility, and Anthropic/OpenAI/Google usage is billed to that provider's account. Authentication options are `COPILOT_GITHUB_TOKEN` (fine-grained PAT, billed to the PAT owner), `permissions: copilot-requests: write` (uses `${{ github.token }}`, bills to an organization Copilot tenant, needs no secret), and keyless federation (Anthropic WIF, Google WIF, Azure Entra OIDC for Codex). `engine:` accepts `claude`, `codex`, `gemini`, `pi` and `agy`, plus declarative third-party engines through `secret-strategy: universal-llm-consumer`.

**Decision:** Keep Copilot on both workflows and cap the spend in frontmatter.

- `copilot-triage`: `max-ai-credits: 150`, `max-daily-ai-credits: 300`.
- `feature-scout`: `max-ai-credits: 400`, `max-daily-ai-credits: 400`.
- Auth stays on the `COPILOT_GITHUB_TOKEN` PAT because `copilot-requests: write` only applies to organization-owned repositories, and `svg153/nan-vscode` is user-owned.
- The provider swap targets the NaN Builders gateway (`https://api.nan.builders/v1`), the same OpenAI-compatible endpoint the extension uses, so the private deployment can bill NaN credits rather than Copilot AI Credits. It is staged as a commented `engine:` draft (`codex`, `deepseek-v4-flash`, `OPENAI_BASE_URL`, `api.nan.builders`) in `feature-scout.md` and documented in `docs/agentic-pipeline.md#swapping-the-model-provider-draft`.
- It is deliberately not enabled, for two reasons. `copilot-triage` hands work to the Copilot coding agent through `safe-outputs: assign-to-agent`, which makes Copilot load-bearing there, so only `feature-scout` is a candidate. And the Codex engine speaks the Responses API (`/v1/responses`), which the extension does not exercise today, so the gateway's Responses support has to be verified before the draft can be turned on.

**Follow-up:** Revisit if the repository moves under an organization (which unlocks `copilot-requests: write` and central billing), or if `feature-scout` becomes the dominant AI Credit consumer. The next concrete step for a private deployment is the `/v1/responses` check in `docs/agentic-pipeline.md#swapping-the-model-provider-draft`, then a priced `feature-scout` run from `gh aw logs --json` before switching.

## AUTONOMOUS-DECISION: November model reasoning ladders follow the published bullets

**Question:** Which `reasoningEffortValues` should `qwen4-max` and `hy4-flash` declare, given that NaN's "Controlling reasoning" ladder table does not cover the November additions (`kimi-k3.1-pro`, `qwen3.8-max`, `deepseek-v4-pro`, `hy4`, `qwen4-max`, `hy4-flash`)?

**Options:**

- `[]` for both, treating every model outside the ladder table as model-managed (the `kimi-k3.1-pro` / `deepseek-v4-pro` convention).
- The full canonical ladder for both, assuming the November models accept `none` through `max`.
- Per-model: the ladder only where the model's own bullet enumerates the levels, `[]` otherwise.

**Research:** https://nan.builders/docs/models gives each model a reasoning bullet outside the ladder table. `qwen4-max` says `reasoning_effort` accepts `none` to turn reasoning off and `minimal` to `max` to steer depth, and that `max_tokens` bounds reasoning plus answer (up to 131,000). `hy4-flash` says it reasons by default with no default level applied, that `none` turns it off, and that `max_tokens` bounds reasoning plus answer (up to 64,000); it does not enumerate the levels. `hy4`, added in the same wave, already declares `["none","minimal","low","medium","high","max"]`.

**Decision:** Per-model. `qwen4-max` declares `["none","minimal","low","medium","high","xhigh","max"]` because its bullet enumerates `none` plus `minimal`..`max`. `hy4-flash` declares `[]` because no per-level contract is published, matching `kimi-k3.1-pro` and `deepseek-v4-pro`; an empty ladder keeps VS Code's depth control away from an undocumented surface while `defaultReasoningEffortForModel([])` still resolves to `low`, which is inside the documented range.

**Follow-up:** Replace `[]` with the enumerated ladder once NaN publishes the levels for `hy4-flash` or adds the November models to the ladder table, and add a validation step that compares picker depth choices with the published levels.

## PENDING-DECISION: vendor id vs. the nan-builders collision

**Question:** `PROVIDER_VENDOR` is `nan-builders`, and `SrScorpio/nan-bridge` registers the same vendor id (#118), so the two extensions can expose duplicate models. Should the vendor id stay `nan-builders`, be renamed now, or be frozen as a contract?

**Options:**

- (A) Keep `nan-builders` and document the coexistence problem only.
- (B) Rename to `svg153-nan-builders` now.
- (C) Keep `nan-builders` and treat the string as an immutable contract, recording the naming/brand-handover implications in the entry with an explicit follow-up for a future handover.

**Research:** The vendor id reaches the API surface in four places: `src/constants.ts` (`PROVIDER_VENDOR`), `src/extension.ts` (`vscode.lm.registerLanguageModelChatProvider`), `package.json` (`contributes.languageModelChatProviders[0].vendor`, a separate literal rather than a derived value) and `test/insidersIntegration.ts` (`selectChatModels({ vendor: "nan-builders" })`). The token is also overloaded inside this repository: the Copilot app plugin at `com.github.copilot/extensions/nan-builders` uses `nan-builders` as its plugin name in a different namespace. Issue #118 reports that VS Code treats `(vendor, model id)` as model identity, which is why a shared vendor can duplicate model entries.

*Assumption (not verifiable in this repository):* VS Code persists model selections and chat-history model references against the provider that produced them, so renaming the vendor id would silently break stored selections. The repository contains no code that reads or migrates that store, so option B would need a migration design before it ships.

**Decision:** Pending maintainer approval (recorded 2026-11-16). Recommendation: option C. It keeps today's stored selections working, treats the collision as a coexistence/documentation problem instead of a data-loss risk, and leaves a rename possible later only through a documented migration. The vendor id is an internal identifier rather than the product name, so a future brand handover or rebrand does not require changing it.

**Follow-up:** If C is approved, open a child issue for (a) a documented rename/migration procedure if coexistence proves unacceptable in practice, (b) the runtime duplicate-provider warning from #118 option (c), and (c) a public note about the shared vendor id once concurrent README edits are safe. Any handover agreement must state whether the vendor id transfers with the extension identity.

## AUTONOMOUS-DECISION: trim history in atomic units, middle-out

**Question:** When a conversation exceeds the model's input budget, what should be dropped before the request is sent, and in what order?

**Options:**

- Drop individual messages or characters until the estimate fits. This is the simplest rule, but an assistant `tool_calls` entry can lose the `tool` results that reference it, and the gateway then rejects the payload with a validation error that is harder to act on than the context-length 400 it was meant to prevent.
- Drop atomic units from the oldest end. That keeps payloads valid but removes the conversation opening, which is where the user's framing and the first instructions live.
- Drop atomic units from the middle outward, preserving system framing, the first unit, and the trailing unit (chosen).

**Research:** OpenAI-compatible gateways require every `tool` message to reference a `tool_calls` id declared earlier in the same request, so a trim unit must be an assistant message together with its `tool_calls` and every result that references them. `SrScorpio/nan-bridge` trims with the same atomic rule and preserves the first unit and the current turn. The older turns in the middle of a long agent conversation are the least load-bearing: the opening still anchors the task and the trailing unit is the request being answered.

**Decision:** `src/openai/historyTrim.ts` groups the converted payload into atomic units and discards whole units from the middle outward until the input estimate fits `maxInputTokens`, which `toModelInfo` already derives as `max(1, min(context - maxOutput, 0.9 * context))`. System messages, the first unit (including the first user turn after leading system framing), and the trailing unit are never trim candidates; when those alone exceed the budget the request is still sent, because dropping the current request would be worse than a context error. Trimming is silent when the history already fits: the same array is sent unchanged, which is covered by a no-op regression test. The estimate comes from `countOpenAIMessageTokens` in `src/openai/tokens.ts`, the same module `provideTokenCount` uses, so the trim decision and the host-reported counts cannot drift apart. Each trim writes one `chat.history.trimmed` diagnostic line with unit counts and estimated tokens before/after, never message content, and the user sees at most one warning per conversation, keyed by a hash of the first unit rather than by stored text.

**Follow-up:** Revisit if the gateway rejects a middle trim with a validation error (which would mean the unit boundary needs to include more context than the `tool_calls` pair), or when image counting changes, since a cheaper estimate would delay the trim. Summarizing discarded history stays a non-goal until the trim itself is proven in long agent turns.

## AUTONOMOUS-DECISION: queue requests per API key at the gateway limit

**Question:** The NaN gateway serves 7 concurrent requests per API key across every endpoint, and answers the eighth with HTTP 429. Agent turns fire several tool calls at once and opt-in inline completions add more, so bursts run into the limit. How should the extension stay under it without slowing the ordinary single-request case?

**Options:**

- Let the 429s happen and retry them. This hides the burst instead of preventing it, multiplies load exactly when the gateway is already saturated, and a retry is a second billed attempt the user never asked for.
- Serialize every request to one at a time. Correct but needlessly slow: it wastes six of the seven slots the plan already pays for.
- One first-in-first-out queue per API key whose capacity is the gateway limit, shared by chat and inline completions (chosen).

**Research:** The limit is per key, not per model, per endpoint, or per extension, so the correct scope for the queue is the credential. Issue #120 adds multi-key profiles, which means the queue has to be addressable by a credential identifier rather than by a single module-level queue. Node offers no timer-free semaphore, but a FIFO queue of promises takes a slot synchronously when one is free, so the uncontended path never schedules a timer and adds no latency. A queued request must be cancellable: VS Code cancels chat turns and inline completions constantly, and an abandoned waiter that later receives a slot would send a request for work nobody wants and hold the slot until it finished.

**Decision:** `src/openai/slotQueue.ts` holds a `SlotQueue` (FIFO waiters, `capacity` slots, `acquire(signal)` returning an idempotent `SlotLease` whose `waited` flag records queueing) and a `SlotQueueRegistry` that keeps one queue per credential. The registry keys queues by a truncated SHA-256 fingerprint of the API key, so the raw secret is never a map key and #120 can pass its profile id to `forCredential` with no change to the queue. `nanBuilders.maxParallelRequests` (default 7, minimum 1, capped at the documented gateway maximum of 7) is read live on every acquire and release, and `SlotQueueRegistry.refresh()` applies a change to waiters already parked. A signal that aborts while waiting rejects with `SlotQueueCancelledError`, which uses the `AbortError` name so the existing cancellation mapping treats it as a cancel, and the waiter leaves the queue without consuming a slot or sending a fetch. Slots are acquired after endpoint authorization, so the HTTP consent prompt never holds one, and are held until the response is finished: `sendChatRequest` acquires, covers its compatibility fallback re-send with the same lease, releases and rethrows on failure, and returns the lease to `provideLanguageModelChatResponse`, which releases it in its existing `finally` after the stream reader is done or cancelled. Inline completions acquire in `requestInlineCompletion` around the `/completions` fetch and release in `finally`, so HTTP errors, network failures, oversized bodies, and cancellation all free the slot. `src/extension.ts` creates one registry per window and passes it to both providers. There is no automatic 429 retry: a 429 that still arrives propagates through `src/providerErrors.ts` with its `Retry-After` hint.

**Follow-up:** #120 replaces the key fingerprint with the profile id it resolves for each request. If inline completions ever starve interactive chat, add priority to the queue rather than a second queue, so the per-key total still cannot exceed the gateway limit.