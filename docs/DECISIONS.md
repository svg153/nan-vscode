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

- The status wins for 401/403 and 402, because a key that cannot authenticate or a billing refusal is never a throttle or a model problem. Everywhere else `error.type` / `error.code` / `error.param` from the JSON body takes precedence over the bare status, so a 429 whose code says `insufficient_quota` points at **Show Usage** instead of a wait.
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
