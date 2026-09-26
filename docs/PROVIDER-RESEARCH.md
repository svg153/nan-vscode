# Provider extension research

This repository deliberately follows the smallest native VS Code provider shape instead of building a second chat UI.

| Reference | Useful pattern | Decision for NaN Builders |
| --- | --- | --- |
| [VS Code chat provider guide](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) and [official sample](https://github.com/microsoft/vscode-extension-samples/tree/main/chat-model-provider-sample) | Native LanguageModelChatProvider, Chat/Agent integration, streamed response parts. | Keep the current native provider and use VS Code's model picker. |
| [Hugging Face VS Code Chat](https://github.com/huggingface/huggingface-vscode-chat) | Provider discovery, management command, external account/model configuration. | Keep SecretStorage and /v1/models discovery; do not copy its account assumptions. |
| [OAI Compatible Copilot](https://github.com/jiaruihuang/oai-compatible-copilot) | Rich per-provider/per-model options, custom headers, retries, reasoning controls. | Treat these as later extensions, not MVP configuration surface. |

## Usage

VS Code does not currently expose a documented usage-reporting callback for third-party chat providers. The extension's status bar therefore reports local session totals from streamed NaN usage metadata. Account-wide usage remains issue [#7](https://github.com/svg153/nan-vscode/issues/7) and must use a stable API-key-authenticated NaN endpoint.

## Inline completions

Chat providers do not automatically provide ghost text. Inline suggestions use the separate InlineCompletionItemProvider API. The extension now ships opt-in ghost-text completions through the legacy `POST /v1/completions` endpoint: they stay disabled unless `nanBuilders.completionModel` is set, bound prompt and suggestion context, honor request cancellation, and show no text on any failure. This implements the research/PoC tracked in issue [#8](https://github.com/svg153/nan-vscode/issues/8).

## Product boundary

- The current extension supports native Chat and Agent mode, model discovery, streaming, tool calls, vision metadata, SecretStorage, and remote/WSL UI-host behavior.
- It does not claim account quota or browser-session reuse; inline ghost-text completions exist but are opt-in and off by default.
- The extension remains community-maintained until NaN Builders approves official branding and publisher ownership.
