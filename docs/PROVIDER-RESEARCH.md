# Provider extension research

This repository deliberately follows the smallest native VS Code provider shape instead of building a second chat UI.

| Reference | Useful pattern | Decision for NaN Builders |
| --- | --- | --- |
| [VS Code chat provider guide](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) and [official sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-model-provider-sample) | Native LanguageModelChatProvider, Chat/Agent integration, streamed response parts. | Keep the current native provider and use VS Code's model picker. |
| [Hugging Face VS Code Chat](https://github.com/huggingface/huggingface-vscode-chat) | Provider discovery, management command, external account/model configuration. | Keep SecretStorage and /v1/models discovery; do not copy its account assumptions. |
| [OAI Compatible Copilot](https://github.com/jiaruihuang/oai-compatible-copilot) | Rich per-provider/per-model options, custom headers, retries, reasoning controls. | Treat these as later extensions, not MVP configuration surface. |

## Usage

VS Code does not currently expose a documented usage-reporting callback for third-party chat providers, so local session totals only include turns where NaN returns OpenAI-compatible streaming usage metadata. Account-wide usage is shipped through the API-key-authenticated `GET /v1/usage` endpoint; the status bar and **NaN Builders: Show Usage** use that snapshot when a key is configured, with local usage as a fallback. Since NaN's 2026-11-10 billing change the endpoint reports plan credits (`allowance`, `used`, `remaining`, optional pack) instead of per-model monthly token quotas, so percentages are each model's share of the plan allowance. From 2026-11-11 rows and totals also carry `cached_tokens` (a subset of `prompt_tokens`), and the credits object reports `period_start`/`period_end` plus `frozen`, which is true while the subscription is inactive and credit-billed requests are refused. The extension does not reuse browser cookies or `nan-cli` sessions. See the [usage and limitations](../README.md#usage-and-limitations) section and [implementation decisions](DECISIONS.md) for the current behavior and remaining limitations.

Two client-side details come from comparing with the `SrScorpio/nan-bridge` project, which solved the same problems against the same API:

- `pack_expires_at` arrives as a timestamp but is meant to be read as a date, so it is rendered with the remaining days and a today/tomorrow/expired wording rather than passed through.
- Because NaN rounds each usage row and each model aggregate independently, summing the per-model rows of the calendar-month window is only approximately the billing-period `used` total. The QuickPick exposes that sum as an explicitly approximate **Window credits (calendar month)** row and keeps the headline percentage on `credits.used`.
- NaN Cloud (`cloud.nan.builders`) is a single-page console with a catch-all route: only hash deep links resolve, and the API-key section is `#settings-api-keys`. `/keys` and `/api-keys` render the shell but not the section, so the extension links to the hash form.

## Token counting

`provideTokenCount` and the history trimmer estimate from one module (`src/openai/tokens.ts`), so the host's context warning and our own trimming never disagree about the same payload:

- Text costs one token per four characters. Tool-call payloads are counted as the tool name plus the JSON arguments that are actually serialized into the request, using the same serializer as the request builder.
- Every part that carries image data costs a flat **1024 tokens**, the per-image value `SrScorpio/nan-bridge` uses. OpenAI documents `76 + area / 512` for gpt-4o: more accurate, but it needs decoded dimensions, while the flat value stays predictable.
- Tool results are counted recursively, so nested tool calls and images inside a result are included. Unrecognized parts keep the previous fixed allowance of 16 tokens.

This remains an estimate: no per-model tokenizer, no counting endpoint, and no credit or cost math derived from it.

## Inline completions

Chat providers do not automatically provide ghost text. Inline suggestions use the separate InlineCompletionItemProvider API. The extension now ships opt-in ghost-text completions through the legacy `POST /v1/completions` endpoint: they stay disabled unless `nanBuilders.completionModel` is set, bound prompt and suggestion context, honor request cancellation, and show no text on any failure. This implements the research/PoC tracked in issue [#8](https://github.com/svg153/nan-vscode/issues/8).

## Product boundary

- The current extension supports native Chat and Agent mode, model discovery, streaming, tool calls, vision metadata, SecretStorage, and remote/WSL UI-host behavior.
- It supports account-wide credit usage reporting through `GET /v1/usage`; it does not reuse browser sessions. Local session totals remain limited to turns with streaming usage metadata, and inline ghost-text completions are opt-in and off by default.
- The extension remains community-maintained until NaN Builders approves official branding and publisher ownership.
