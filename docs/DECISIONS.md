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
