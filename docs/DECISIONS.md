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

## AUTONOMOUS-DECISION: vendor id stays `nan-builders` as an immutable contract

**Question:** `PROVIDER_VENDOR` is `nan-builders`, and `SrScorpio/nan-bridge` registers the same vendor id (#118), so the two extensions can expose duplicate models. Should the vendor id stay `nan-builders`, be renamed now, or be frozen as a contract?

**Options:**

- (A) Keep `nan-builders` and document the coexistence problem only. Zero code and zero risk today, but the collision stays and two providers can surface the same model ids, so the ambiguity becomes a permanent known defect with no signal at runtime.
- (B) Rename to `svg153-nan-builders` now. Unique from the first day, but it invalidates the stored model selections of every existing user (see the assumption below) in exchange for a cosmetic disambiguation, and it forces the same edit into `package.json` and the integration test.
- (C) Keep `nan-builders` and treat the string as an immutable contract, recording the naming/brand-handover implications in the entry with an explicit follow-up for a future handover. Nothing breaks today, the collision is answered with a runtime warning and public documentation instead of a rename, and a rename stays available later only as a documented migration.

**Research:** Verified against `main` (`2f59e63`, 2026-11-18). The vendor id reaches the API surface in four files and six occurrences, and nothing outside `src/` derives from the constant, so a rename cannot drift silently: `src/constants.ts:1` defines `PROVIDER_VENDOR = "nan-builders"`; `src/extension.ts` consumes it three times — the `activate.provider.vendor` diagnostic (line 279), `vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, provider)` (line 298) and the host-model refresh `selectHostModels(vscode.lm, PROVIDER_VENDOR)` (line 1146); `package.json` declares `contributes.languageModelChatProviders[0].vendor` as the separate literal `"nan-builders"` (line 50); and `test/insidersIntegration.ts:234` filters with `selectChatModels({ vendor: "nan-builders" })`. The token is also overloaded inside this repository: the Copilot app plugin at `com.github.copilot/extensions/nan-builders` uses `nan-builders` as its plugin name in a different namespace. `README.md` already states the user-visible consequence (line 130), but only inside the profiles section: duplicate model entries and no shared profile configuration. Issue #118 reports that VS Code treats `(vendor, model id)` as model identity, which is why a shared vendor can duplicate model entries and why a stored `nan-builders/<model>` selection does not name the extension that produced it.

*Assumption (not verifiable in this repository):* VS Code persists model selections and chat-history model references against the provider that produced them, so renaming the vendor id would silently break stored selections. The repository contains no code that reads or migrates that store, so option B would need a migration design before it ships. The same gap is what makes B expensive rather than merely annoying: the extension could not repair those values even if it wanted to.

**Decision (approved 2026-11-18):** Option C. `nan-builders` stays, and the string is treated as an immutable contract rather than an implementation detail that follows the product name. The vendor id is an internal identifier, not the Marketplace identity (`svg153.nan-builders-vscode`), so a future brand handover or rebrand does not require changing it. Concretely:

- No rename, no migration, no change to stored selections. Option B's entire cost is paid by users and buys only a disambiguation that the runtime warning and the public note deliver without a reset.
- The collision is classified as a coexistence and documentation problem, not a data-loss risk. Two providers can surface the same model ids, and a stored selection may be served with the other extension's key; users are told to keep one provider active per vendor, and the extension watches for the duplicate instead of pretending it cannot happen.
- If coexistence proves unacceptable in practice, the exit is a documented migration — constant, `package.json` literal, integration-test literal and stored selections together — not an ad-hoc rename. That cost grows with the number of stored selections, which is exactly why it must be deliberate.

**Provenance and reversibility:** the approval is autonomous, recorded by the coordinating agent on 2026-11-18 while running the repository backlog under autopilot, exercising the scope delegated in #118. It is not a maintainer statement and carries no more authority than any other `AUTONOMOUS-DECISION` in this file. A maintainer can override it at any time: choosing A supersedes this entry and leaves only the documentation; choosing B supersedes it and pays the migration cost described above, which is the same cost whether it is paid now or later. Reversing C is cheapest today and grows more expensive only as selections accumulate — it never becomes impossible.

**Deviations:** the manual test of installing both extensions and describing the observed behaviour was not run. This environment cannot install a second provider, and the decision does not depend on reproducing the collision: the mechanism follows from the API contract, the collision is reported in #118, and option C is chosen precisely because it is safe without the reproduction. The runtime detection that would observe it in the field is #169.

**Follow-up:** the accepted option's follow-ups are tracked as child issues. #169 is the runtime duplicate-provider warning (detect another provider on the `nan-builders` vendor and warn once, without renaming or breaking selections). #170 is the public README note about the shared vendor id and coexistence, to be rebased after the concurrent README work in #164 and #165 lands. The rename/migration procedure is deliberately not opened as an issue: it is conditional on coexistence proving unacceptable in practice, and opening it now would invite the very migration this decision rejects. Any handover agreement must still state whether the vendor id transfers with the extension identity; under C the default answer is that it is an internal identifier and need not.

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

**Decision:** `src/openai/slotQueue.ts` holds a `SlotQueue` (FIFO waiters, `capacity` slots, `acquire(signal)` returning an idempotent `SlotLease` whose `waited` flag records queueing) and a `SlotQueueRegistry` that keeps one queue per credential. The registry keys queues by a truncated SHA-256 fingerprint of the API key, so the raw secret is never a map key and #120 can pass its profile id to `forCredential` with no change to the queue. `nanBuilders.maxParallelRequests` (default 7, minimum 1, capped at the documented gateway maximum of 7) is read live on every acquire and release, and `SlotQueueRegistry.refresh()` applies a change to waiters already parked. A signal that aborts while waiting rejects with `SlotQueueCancelledError`, which uses the `AbortError` name so the existing cancellation mapping treats it as a cancel, and the waiter leaves the queue without consuming a slot or sending a fetch. Slots are acquired after endpoint authorization, so the HTTP consent prompt never holds one, and are held until the response is finished: `sendChatRequest` acquires, covers its compatibility fallback re-send with the same lease, releases and rethrows on failure, and returns the lease to `provideLanguageModelChatResponse`, which releases it in its existing `finally` after the stream reader is done or cancelled. Inline completions acquire in `requestInlineCompletion` around the `/completions` fetch and release in `finally`, so HTTP errors, network failures, oversized bodies, and cancellation all free the slot. `src/extension.ts` creates one registry per window and passes it to both providers. The queue itself never retries a 429: a throttle that survives the queue's own admission control propagates through `src/providerErrors.ts` with its `Retry-After` hint, and any transparent retry happens above the queue as its own attempt (see the retry decision below), so a retry never multiplies concurrency behind the queue's back.

**Follow-up:** #120 replaces the key fingerprint with the profile id it resolves for each request. If inline completions ever starve interactive chat, add priority to the queue rather than a second queue, so the per-key total still cannot exceed the gateway limit.
## AUTONOMOUS-DECISION: one key per profile, routed by `profile::model`

**Question:** Several NaN API keys on one machine must serve different models, without a second settings table, without storing keys anywhere but SecretStorage, and without breaking single-key installs. Which profile does a request use, and where does that routing live?

**Options:**

- A new `nanBuilders.modelProfiles` map of model id to profile id. It reads clearly, but it duplicates the store that already answers "what per-model configuration applies", so two tables can disagree about the same model.
- Encode the profile in the model id offered to VS Code. Routing then happens implicitly, but every assigned model appears twice in the picker and chat history references a synthesized id that survives only until the profile is renamed.
- One composite key `profile::model` inside the existing `nanBuilders.reasoningEffortByModel` store, whose value is the reasoning effort for that model under that profile (chosen).

**Research:** Model ids from `/v1/models` are opaque but never contain `::`, so a composite key cannot collide with a plain model id, and a store that is a plain object keeps insertion order for stable menus. #112 keys its slot queue by a fingerprint of the API key, which means routing a request with its resolved profile key already yields one queue per key: no change to `src/openai/slotQueue.ts` was needed, and two profiles sharing a key correctly share one queue because the gateway limit is per key. #118 (vendor identity, still pending) shares the failure mode the issue warns about: two installed providers with vendor `nan-builders` can list duplicate models, so profile ownership is documented as per-extension rather than inferred from the vendor.

**Decision:** `src/profiles.ts` is a vscode-free module that owns the whole contract: `nanBuilders.profiles` holds ids only, `nanBuilders.activeProfile` selects the default, keys live under `nanBuilders.profileKey.<profileId>`, and `resolveModelRoute` answers with a profile id plus its provenance (`native`, `assignment`, `active`, `first`, `legacy`). `src/provider.ts` resolves the credential once, at the boundary where the API key was already read, and throws `ProfileKeyMissingError` naming the profile before any request is built; `effortOverride` prefers the composite entry, where `auto` means "routing only". Deleting a profile writes settings first, then clears the secret and its assignments, and `assignedProfileForModel` ignores assignments naming an unconfigured profile, so a stale entry can never resolve a key. With no profiles configured the route is `legacy` and `nanBuilders.apiKey` behaves exactly as before. Diagnostics print ids, routing, and key presence only; `describeRoute` and the `chat.credential`/`inline.credential` events carry the profile id and a boolean, never a value.

**Follow-up:** If a maintainer decision on #118 renames the vendor, profiles keep working unchanged because nothing in this design keys off the vendor string. If automatic failover lands (#119), it must reuse `resolveModelRoute` rather than invent a second precedence order.

## AUTONOMOUS-DECISION: multi-key rotation stays off; fixed routing, opt-in failover only

**Question:** #120 makes several of the user's own NaN keys addressable by profile and #112 gives each key its own slot queue, so the extension could rotate across them. Should it, and with which strategy: `fixed` (today's behaviour), `round-robin`, or `failover-on-429` with a short per-key cooldown? NaN publishes its limits per API key, so rotation is mechanically the way to get more than one key's worth of throughput, which makes this a policy question before it is a code question.

**Options:**

- `fixed` (chosen): the key `resolveModelRoute` resolves is the key that serves the request. A throttled or exhausted key surfaces its own error, and moving to another key stays a manual act: switch the active profile, or assign the model to another profile.
- `round-robin`: spread requests across every configured key so aggregate throughput approaches the sum of the per-key limits. Billing becomes unpredictable, two keys can be throttled at once, and the feature's only purpose is to exceed what one key allows.
- `failover-on-429`: when a key is throttled, retry the request once on the next configured profile, cooldown the throttled key briefly, and surface the error once every candidate is cooling down.

**Research:** NaN's public pages, checked 2026-11-17. `https://nan.builders/terms` (last updated 2026-11-10) says, under "The community", that "Every inference member gets a personal, non-transferable API key"; under "Acceptable use", "Do not share, resell or transfer your API key", "Do not abuse the shared cluster or attempt to exceed the published limits", and "NaN is inference, not training: use the cluster to run models, not to fine-tune them"; under "Credits", "Credits do not lift any other limit: concurrency, rate limits and fair use still apply"; and under "Holds and bans", the penalty for a breach: "If your account is banned for a breach of these terms, your API key is revoked, automatic recharges are turned off and any remaining pack balance is forfeited without refund." The same section treats a card "used on more accounts than we allow" as a hold trigger. `https://nan.builders/docs` publishes the limits per key, "a cap on requests per minute and a maximum number of requests at once", and `/docs/models` gives the figures: 60 requests per minute, 7 concurrent requests per key on the base plan and 10 on Premium, with a lower per-model concurrency of 5 on `mimo-v2.6-flash`, `qwen3.6` and `gemma4`.

What those pages do not say, and this entry does not invent: they never address several keys on one account, several accounts belonging to one person, or a client rotating between keys, and they never state whether the published per-key caps are an engineering ceiling on one credential or an allowance per member. The portal's plural "API Keys" section in `/docs` suggests more than one key per account is possible, but no published page says what that means for limits. Nothing on those pages may be read as permission for rotation, and the one clause that speaks to it, "attempt to exceed the published limits", reads against it. Treat multi-key rotation as an unverified risk, not a documented right.

**Decision:** `fixed` is the only supported default: rotation is OFF, and this issue ships no rotation code. Multi-key stays a routing feature (#120), not a throughput feature. Rejected outright: `round-robin` in any form, and any rotation triggered by `insufficient_quota` (a 402, or a 429 whose `error.code` reports an empty credit pool, which `src/providerErrors.ts` already separates from a throttle), because moving spend between credit pools is credit trading under another name. Rotation on `invalid_api_key` (401/403) or on a request-level 4xx is rejected too: it would hide a broken configuration instead of relieving a limit.

The only variant this decision leaves open is the opt-in `failover-on-429` of #144, and only in this shape: off by default; own accounts only, configured by the user in *Manage Provider*; triggered solely by a throttle classification (`rate_limit_exceeded`), never by quota or auth failures; at most one hop per request, so a request cannot walk a chain of keys; a per-key cooldown that honours `Retry-After` and is visible in diagnostics; the original error surfaced unchanged once every candidate is cooling down, naming which profiles were tried; and a one-time acknowledgement that several accounts' allowances are not pooled and that the risk is the user's. Even that variant may not create accounts, buy or transfer credits, or read a key the user did not type into SecretStorage. Permanently out of scope: sharing keys between people, storing a key anywhere but SecretStorage, moving balances between accounts, and anything that makes a second account cheaper to obtain.

**Data model:** unchanged from #120. `nanBuilders.profiles` holds ids only (machine scope), each key lives at the SecretStorage name `nanBuilders.profileKey.<profileId>`, and `src/profiles.ts` never returns a credential: `resolveModelRoute` answers with a profile id plus `native`/`assignment`/`active`/`first`/`legacy` provenance, `describeRoute` projects `{ profile, profileSource }` for logs, and `profileKeyPresence` compares SecretStorage names to report `configured`/`missing`. `src/provider.ts` reads the secret at one boundary, inside `resolveCredential`, so a keyless profile throws `ProfileKeyMissingError` with the profile id before any fetch. Any rotation added later must keep that boundary: a policy chooses among profile ids and re-enters `resolveCredential`, so no new path ever holds a key it did not read from SecretStorage, and the `chat.credential`/`inline.credential` payload stays `{ modelId, profile, profileSource, hasKey }`.

**Consumption surface:** a future policy has three hooks and needs no rework to use them. Routing: `resolveModelRoute` in `src/profiles.ts` is the single precedence order, so a policy becomes a wrapper that asks it for an ordered candidate list instead of one route; precedence stays in one place, which is exactly what the #120 follow-up requires. Concurrency: `SlotQueueRegistry.forCredential` keys queues by a truncated SHA-256 fingerprint of the resolved key, so a hop to another profile queues against that key's queue with no change to `src/openai/slotQueue.ts`, and two profiles sharing a key keep sharing one queue. Presentation and state: the *Manage Provider* profile selector owns the ids and the acknowledgement, and profile ids plus cooldown state belong in *Show Diagnostics*, never a key.

**Implemented (#144):** the opt-in variant landed as `nanBuilders.failoverOnThrottle` (boolean, machine scope, default `false`), keeping `fixed` as the default: with the setting off, nothing changed. The policy lives in a `vscode`-free module, `src/failover.ts`, and the candidate order in `src/profiles.ts` (`resolveModelRouteCandidates` returns the route `resolveModelRoute` picks first, then the remaining profiles in settings order labelled `failover`), so precedence still has exactly one home; `src/openai/slotQueue.ts` is untouched and a hop queues against the candidate key's own queue through the existing fingerprint. `src/provider.ts` resolves each candidate through the same `SecretStorage` helper that serves the routed key, reads secondary keys lazily (only after a throttle) and emits `chat.failover` with `{ modelId, from, to, reason, cooldownSeconds }` plus `chat.credential` carrying `profileSource: "failover"`, so no payload holds a key. Trigger, one hop, cooldown, and error decoration follow the shape above with two clarifications the implementation fixed: the routed key is always attempted first even while it is cooling (routing stays fixed and a stale window cannot silently move a model to another account), and when no profile can serve the retry the *same* `ProviderError` object propagates — classification, retryability and `Retry-After` intact — with `Profiles tried: <ids>.` appended, which is the "unchanged plus named profiles" reading of the two constraints. Deliberate scope limits: a native per-model key (`Manage Models → API Key`) never hops, because the user chose that key for that model; inline completions are excluded (failover is chat only, so ghost text never spends a second account); and a single-profile install is a straight pass-through. Diagnostics gained a `Failover on throttle: on (one hop per request) | off (fixed routing)` line and a cooldown list of profile ids with whole seconds left, never a key.

**Follow-up:** The opt-in variant is #144; if it lands, this default stays `fixed` and the setting stays off. Two implementation constraints bind it, because both already exist and a second mechanism would be a bug: `src/providerErrors.ts` classifies a 429 as `rate_limit_exceeded` or `insufficient_quota` from `error.code`, so failover must key off that classification rather than the HTTP status, and `resolveModelRoute` plus the #112 per-key slot queue are the only allowed hooks — no second precedence order and no second queue. Two findings from this research belong to other work: the published per-key concurrency is plan-dependent (7 base, 10 Premium) while `nanBuilders.maxParallelRequests` caps at 7, so Premium users leave three slots unused and the ceiling is stale; and three models cap concurrency at 5 per key, which a single per-key queue of 7 cannot distinguish. Both are queue improvements, not rotation ones. #118 (vendor id) is still pending; this decision does not depend on it, and under option C each installed provider keeps its own profiles, which is the safe outcome for a policy that spends the user's credits.

## AUTONOMOUS-DECISION: retry transient failures before the stream starts, on the same key

**Question:** #112 queues requests so the gateway rarely answers 429, and #144 can hop to another profile when one is throttled, but a single transient blip — a throttle, a 502/503/504 from the shared gateway, a connect timeout, a dropped connection — still ends the turn with an error the user has to retry by hand. Which failures should the provider absorb itself, how long should it wait, and how does that compose with the opt-in failover that already exists?

**Options:**

- Retry nothing (status quo before #151). Every transient blip costs a turn, and agent turns that fire several tool calls fail several of them at once.
- Retry every failure, including those after the stream started. Rejected: replaying a request whose reply is already partly rendered duplicates text and tool calls the user has seen, and retrying a 4xx bills a request that will fail identically every time.
- Retry only failures that happen before the response body is handed out, on the same key, with the gateway's own `Retry-After` as the wait (chosen).

**Research:** `src/providerErrors.ts` already owns the whole classification and is `vscode`-free: `ProviderError.retryable` is true exactly for `rate_limit_exceeded`, `timeout`, `network` and `gateway_error`, `insufficient_quota` and every other 4xx are false, `parseRetryAfter` already reads both the numeric and the HTTP-date form of the header, and `429` with `error.code: insufficient_quota` is deliberately *not* a throttle because the credits pool is empty. Duplicating any of that in a retry module would be the second source of truth this project avoids, so the retry policy reuses it directly. What the classification cannot express is *when* a failure happened: `RequestTimeoutError` (from `src/openai/timeouts.ts`) and `ProviderTimeoutError` both map to `timeout` whether the headers or the stream body timed out, and `ProviderError` carries no HTTP status, so all 5xx collapse into `gateway_error`. `src/openai/timeouts.ts` also latches: once a controller has settled or its timer has fired, `touch()` and `armConnect()` are ignored, and an `AbortSignal` cannot be un-aborted, so a retry cannot reuse either object.

**Decision:** `src/retry.ts` (no `vscode` import) holds the policy: `resolveMaxRetries` clamps `nanBuilders.maxRetries` (default `2`, `0` disables, capped at `5` so a typo cannot become a retry storm), `preStreamRetryError` returns the mapped `ProviderError` only when it is retryable *and* the failure happened before streaming — `RequestTimeoutError` with `kind` other than `connect` and `ProviderTimeoutError` with `phase` other than `connect` are refused, which is the non-goal "never retry after the stream started" expressed in code rather than in prose — `retryDelayMs` honors a `Retry-After` when present and otherwise doubles a 500 ms base with half-jitter, and `waitForRetry` sleeps on a timer that rejects with the abort reason and clears itself the instant VS Code cancels. Both waits are capped at 8 s: a hostile or mistaken `Retry-After: 600` therefore surfaces as the ordinary 429 error instead of parking a turn for ten minutes, and the cap is short enough that the user sees a stall, not a hang. `src/provider.ts` gains `sendChatWithRetries`, which loops `sendChatRequest` per profile attempt; each attempt builds a fresh `AbortController` linked to the request-wide cancellation (`linkedSignal`) and a fresh `ChatTimeoutController`, so an aborted signal or a fired connect timer can never leak into the next attempt, and an exhausted connect timeout is rethrown and still reported as a timeout rather than as a generic failure. `src/openai/slotQueue.ts` is untouched: the failed `sendChatRequest` already releases its lease in its own `catch`, so a request that is waiting to retry holds no per-key capacity and another request can use the key meanwhile.

**Ordering with failover (#144):** retry first, hop only after the retry budget is spent. `runWithFailover` calls one attempt per candidate profile, and `sendChatWithRetries` lives inside that attempt, so the routed key is used for its full `1 + maxRetries` attempts and only the throttle error that survives all of them reaches `isThrottleError` and the single hop. The alternative — hop first, retry on the new key — was rejected because it spends a second account's allowance before the routed key's own budget is used, and it would let one blip move a model to a key the user did not route it to. Consequences worth stating: retries never change keys (that stays #144's job, still off by default), `insufficient_quota` and 4xx are neither retried nor failed over, and a `maxRetries: 0` install reproduces the pre-#151 behaviour exactly, including the failover trigger.

**Deviations from the issue text:** three, all deliberate. First, the issue names 502/503/504; the implementation retries every 5xx, because `ProviderError` has no status field and `gateway_error` is the classified form of all of them (504 arrives as `timeout`). Narrowing it would mean teaching `src/providerErrors.ts` a status it deliberately does not expose, so a superset is the smaller and more coherent change. Second, the `Retry-After` and backoff cap is 8 s, which the issue did not fix; it is documented in the setting and in the README rather than left implicit. Third, tests live in `test/retry` policy cases inside `test/provider.test.ts` (pure) plus end-to-end cases in `test/providerDiscovery.test.ts` (fake timers, real `Response` objects), because the provider's fetch harness lives there and duplicating it would be worse than an extra file's worth of tests.

**Follow-up:** Inline completions are excluded on purpose — they are opt-in, latency-critical, and a retry would show ghost text for a cursor that has moved — so if that ever changes it needs its own budget. A retried request is a billed attempt, so if retries ever become frequent enough to matter, prefer making the gateway rarer (the queue) over raising the default. Two open items belong to other work: `nanBuilders.maxParallelRequests` still caps at 7 while Premium allows 10, and the per-model concurrency of 5 on `mimo-v2.6-flash`, `qwen3.6` and `gemma4` is invisible to a per-key queue.

## AUTONOMOUS-DECISION: choose the inline completion model from a command, without touching the request

**Question:** #175 exposes the inline completion model as a command instead of a hand-edited setting, and the feature is turned off by clearing `nanBuilders.completionModel`. Should the command also change how ghost text is requested, and where should the picker rows live?

**Options:**

- Build a second completion path for the chosen model, with its own discovery and defaults.
- Add a command that only writes the existing setting, leaving the `/completions` payload, the debounce, and the default-off behaviour unchanged (chosen).
- Enable inline completions by default so the command always has a model to show. Rejected: ghost text is opt-in and each request is billed.

**Research:** `src/inlineCompletionProvider.ts` reads `nanBuilders.completionModel` on every invocation, and `src/extension.ts` already registers or disposes the provider from a `syncInlineCompletions()` call inside the `onDidChangeConfiguration` listener. `provideLanguageModelChatInformation({ silent: true })` is the same cache the chat model picker fills, so the command can reuse discovery instead of adding a request path.

**Decision:** `nanBuilders.setCompletionModel` opens a QuickPick built by `buildCompletionModelPickItems` in the `vscode`-free `src/completionModelPicker.ts`. `completionModelFromPick` maps a row to the setting value: a model id writes it, the `DISABLE_COMPLETION_MODEL_LABEL` row writes `""`, and a dismissed picker returns `undefined`, so nothing is written. `setCompletionModel` in `src/extension.ts` performs discovery and the global configuration update; the existing listener registers or disposes the provider. The `/completions` payload, the debounce, and the default-off behaviour are unchanged, and a discovery failure or an empty model list leaves the setting untouched behind a non-modal warning.

**Follow-up:** If inline completions ever become opt-in per language instead of per model, revisit the disable row; today it is the only path that clears the setting without the settings UI.

## AUTONOMOUS-DECISION: the profile picker is a pure module and reuses the settings listener

**Question:** #184/#193 switches the active profile from the command palette and shows that profile in the status bar tooltip. Where should the QuickPick rows and the status bar label live, and how should the label learn that the active profile changed?

**Options:**

- Build the rows inline in `src/extension.ts` and refresh the status bar with new event wiring.
- Extract the rows and the label into a `vscode`-free module, and let the existing `onDidChangeConfiguration` -> `provider.refresh()` path carry the update (chosen).

**Research:** `UsageTracker` already renders the status bar text and imports `statusBarProfileLabel`, and `src/extension.ts` refreshes the provider and the usage view from one `workspace.onDidChangeConfiguration` handler. A second notification path would duplicate that refresh and could show a label that disagrees with routing. `resolveActiveProfile` is the single precedence rule, so marking a row without it could show an "active" profile that is not the one serving requests.

**Decision:** `src/profilePicker.ts` imports no `vscode` and owns `buildProfilePickItems`, `profileFromPick`, and `statusBarProfileLabel`. `buildProfilePickItems` marks the profile returned by `resolveActiveProfile`, so an empty or stale `nanBuilders.activeProfile` still displays the routing truth; `profileFromPick` returns the id to write, or `undefined` when the picker is dismissed; `statusBarProfileLabel` returns a name only when more than one profile is configured, because a single profile adds noise without an action. `switchActiveProfile` writes through `writeProfileSettings` and calls `provider.refresh()`, and the label follows through the existing configuration listener, so no new wiring was added. Only profile ids are shown; keys stay in SecretStorage.

**Follow-up:** Keep any future status bar profile text in this module rather than formatting it in `UsageTracker`, so the pure rows and the label cannot disagree about which profile is active.

## AUTONOMOUS-DECISION: a small glob matcher and a zero-cost exclusion guard

**Question:** #189 skips inline completions for excluded languages and file patterns, but the check runs on every keystroke and the repository avoids new runtime dependencies. Which glob syntax should be supported, how should casing behave, and where should the guard sit?

**Options:**

- Use a general glob library, or expand braces and character classes by hand so patterns behave like `.gitignore`.
- Support only `**`, `*` and `?` in a hand-rolled `globToRegExp`, match case-insensitively on every platform, and return before any request work (chosen).

**Research:** Inline completions are latency-sensitive, so the guard should be pure and cheap; `src/completionExclusions.ts` imports neither `vscode` nor a package. VS Code file globs are case-insensitive on Windows, and a setting typed with different casing must not change the outcome on another platform, which is why the compiled expression always uses the `i` flag. A pattern without a leading `**` may match at any depth (`*.pem` matches `src/a.pem`), mirroring VS Code file globs, and both `/` and `\` are accepted as separators. Braces and character classes are deliberately not expanded: they carry most of the dialect ambiguity, and the smaller language is the easier contract to document.

**Decision:** `src/completionExclusions.ts` holds `DEFAULT_COMPLETION_EXCLUDED_LANGUAGES` (`plaintext`, `dotenv`, `properties`), `DEFAULT_COMPLETION_EXCLUDED_GLOBS` (`**/.env*`, `**/*.pem`, `**/*.key`, `**/secrets/**`), `isCompletionExcluded`, `globToRegExp`, and `readStringList`. `readStringList` returns `undefined` for a hand-edited non-array value, so the defaults still apply instead of breaking completion. In `src/inlineCompletionProvider.ts` the guard runs after the previous request is aborted and before the secret is read, the request is built, a queue slot is taken, or usage is recorded, so an excluded document costs nothing and stays silent; the run emits the `inline.excluded` diagnostic and returns `undefined`.

**Follow-up:** Add brace or character-class support only when a reported pattern needs it, and extend `globToRegExp` rather than swapping in a library, so the guard stays dependency-free.

## AUTONOMOUS-DECISION: a stale discovered catalog outranks the curated one, never a live discovery

**Question:** #196 keeps the model picker usable while `/v1/models` is failing. Where should the last live list live, how old may it be, and what may it outrank?

**Options:**

- Keep only the curated catalog when discovery fails (the behaviour before #196).
- Persist the last live list in `globalState`, serve it first on failure, and re-validate every entry on read (chosen).
- Persist it in workspace settings or a file so it can be inspected and edited. Rejected: it is per-machine state, not configuration, and it must not enter a repository.

**Research:** The curated catalog is conservative by design and cannot know about models added to the gateway after the release, while the last live list is the only record of what the user's key could actually call. It is also the more likely list to be stale, so it may stand in only while a fresh discovery is failing. `globalState` is per-machine and never enters a workspace, which matches state that should not be shared or committed.

**Decision:** `src/modelPersistence.ts` defines the envelope under `PERSISTED_MODELS_KEY` (`nanBuilders.lastDiscoveredModels`) with `PERSISTED_MODELS_VERSION` 1 and `MAX_PERSISTED_MODEL_AGE_MS` of 30 days. `serializeModelList` rebuilds each entry through `parseDiscoveredModel`, so only ids and documented metadata fields are stored; `parsePersistedModelList` returns `undefined` for a non-string, unparsable JSON, an unknown version, a missing or out-of-range `savedAt` (including a future timestamp), or no valid entry, and drops individual malformed entries instead of the whole list. In `src/provider.ts`, `persistDiscoveredModels` writes only after a successful non-empty discovery and catches a storage failure as `models.persist.failed`, because persistence may never break the picker; `persistedCatalogModels` re-filters the parsed list with the current `includeUnknownModels` and `discoveryMode` settings and marks every model `persisted`, so `toModelInfo(metadata, fallback?)` renders `NaN Builders - not live-verified`. When discovery fails the order is persisted list, then the curated static catalog; a live discovery always replaces both, and `auto` mode never falls back to the curated catalog because it targets third-party endpoints.

**Follow-up:** If NaN ever ships model metadata in `/v1/models`, most of the curated catalog can go and the fallback age cap can be revisited once gateway outages are measured.

## AUTONOMOUS-DECISION: one redacted report behind show and copy

**Question:** #195 copies the diagnostics report to the clipboard so it can be pasted into a bug report. Should the copy command build its own text, and how can its redaction stay identical to "Show Diagnostics"?

**Options:**

- Let the copy command assemble its own report from the same pieces; the two outputs can then drift silently.
- Extract the snapshot and the report into shared helpers used by both commands, and prefix the clipboard text with a paste notice (chosen).

**Research:** Clipboard text is likely to be pasted in public, so a difference in redaction between the two commands is a leak rather than a cosmetic bug. The report already carries versions, counts, model ids, and display-only endpoints; `REDACTED` in `src/providerDiagnostics.ts` masks credentials in URLs and parameters, and key values are never read.

**Decision:** `src/extension.ts` splits the work into `diagnosticsInput` and `diagnosticsReport`. `diagnosticsInput` selects host models first because discovery mutates the provider state the report describes, reads secret names only, and returns a `DiagnosticsInput`; `diagnosticsReport` calls `collectDiagnostics` and turns a failure into a user-facing error. `showDiagnostics` and `copyDiagnostics` both consume `diagnosticsReport`, and only `copyDiagnostics` wraps it with `formatClipboardReport`, which prepends an HTML comment stating that the report is safe to paste and contains no keys or `Authorization` headers. `DIAGNOSTICS_COPIED_MESSAGE` confirms the copy, and a clipboard write failure surfaces its own message. Redaction stays in `src/providerDiagnostics.ts` and is applied once to the shared report, so the two commands cannot diverge.

**Follow-up:** If the report ever includes a new category of user data, redact it in `collectDiagnostics` or `formatClipboardReport`, not in either command, so the single redaction path survives.

## AUTONOMOUS-DECISION: the available-models picker reports live metadata and never moves the chat model

**Question:** #190 adds a command that lists the models the configured key can call. Which numbers may the list show, and should selecting a row apply that model to the chat?

**Options:**

- Show every field the extension can produce, including curated values for models the live response did not describe.
- Show `maxOutputTokens` and the capability flags only when they came from a live `/v1/models` response, and make selecting a row a read-only copy instead of a model switch (chosen).
- Let the row selection call `selectChatModels`, so the command doubles as a model switcher. Rejected: a lookup the user ran to inspect their key would silently change the conversation they are in.

**Research:** The curated catalog in `src/modelCatalog.ts` is a release-time guess: it cannot know the output ceiling, the modalities, or the tool support of the key that is actually configured, so rendering those fields as if they had been observed would be a promise the extension cannot keep. `provideLanguageModelChatInformation({ silent: true })` already returns the live list behind the same cache the chat picker fills, so the command reads a value it already has instead of adding a second request path.

**Decision:** `src/provider.ts` records the live response in `lastDiscoveryMetadata` and exposes it through `cachedModelMetadata()`. The field is set only by a successful discovery and cleared on a base URL change, a key change, a discovery failure, the curated static fallback, and `refresh()`, so it cannot outlive the state it described and `undefined` means "these models are not live-verified". `src/availableModelPicker.ts` imports no `vscode` and exports `AvailableModelOption`, `AvailableModelPickItem`, `buildAvailableModelPickItems` and `formatTokenCount`; rows are deduplicated by id, the first occurrence of a duplicate wins, and the capability line is rendered from the same option the numbers come from. `showAvailableModels` in `src/extension.ts` builds the options through `toAvailableModelOptions` and refuses to show a list at all when `cachedModelMetadata()` is `undefined` ? no live proof, no picker ? rather than advertising curated numbers for a key nobody has verified. Selecting a row writes the model id to the clipboard and confirms it, so neither the chat model selection, the `profile::model` routing, nor `nanBuilders.completionModel` can change as a side effect of looking at the list.

**Follow-up:** If a controlled way to switch the chat model from a command ever exists, add it as its own command and keep this one read-only.

## AUTONOMOUS-DECISION: the fill-in-the-middle suffix is session-scoped and blamed only when the retry works

**Question:** #188 sends the code after the cursor as a `suffix`, so a fill-in-the-middle gateway can complete in the middle of a file instead of guessing. Some gateways reject the field. Where should that knowledge live, and when may a model be marked suffix-unsupported?

**Options:**

- Persist the support flag in settings or `globalState`, so one rejection is remembered across reloads.
- Keep the flag in memory for the session, retry once without the suffix, and mark the model unsupported only after that retry succeeds (chosen).
- Skip the suffix permanently for any model that rejects it. Rejected: a failure that has nothing to do with the suffix would disable it for good.

**Research:** Gateway support is a property of the deployed service, not of the user's configuration, and it can change with an upgrade, so storing it as a setting would let a single rejection outlive the behaviour it recorded. The retry is cheap and already bounded, and its outcome is the only evidence that distinguishes "the suffix was refused" from "the request was refused".

**Decision:** `src/inlineCompletion.ts` defines `MAX_SUFFIX_CHARS` at 1000, the `suffix` field on `CompletionRequest`, and `createCompletionSuffixSupport`, which returns an in-memory `CompletionSuffixSupport` with `supports` and `markUnsupported`; nothing is written to settings or `globalState`. `buildCompletionRequest` omits the suffix when support is false or the cursor sits at end of file, and `trimSuffixOverlap` drops the longest start of the suffix that a suggestion repeats at its end so restated code is not inserted twice, with a suggestion left holding nothing but that overlap discarded instead of inserted. `requestInlineCompletion` sends the suffix once, and only when the response is an HTTP 400 or 422 ? the statuses in `SUFFIX_REJECTION_STATUSES` ? retries once through `sendCompletionOnce` without it. If that retry fails, the original outcome is returned and the model is not blamed; `markUnsupported` runs only after the retry succeeds, so a failed request can never teach the session the wrong lesson. `src/inlineCompletionProvider.ts` creates one `suffixSupport` per provider and passes it on every request, so the memory spans documents within a session but not a reload.

**Follow-up:** The flag is dropped on reload and relearned on the first 400 or 422. That is deliberate; persisting it becomes worth revisiting only if a gateway starts rejecting the field on every request.
