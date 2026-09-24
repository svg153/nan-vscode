# NaN Builders for VS Code

[![CI](https://github.com/svg153/nan-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/svg153/nan-vscode/actions/workflows/ci.yml)
[![Release](https://github.com/svg153/nan-vscode/actions/workflows/release.yml/badge.svg)](https://github.com/svg153/nan-vscode/actions/workflows/release.yml)

Use [NaN Builders](https://nan.builders/) models in VS Code Chat and Agent mode through the native `LanguageModelChatProvider` API.

> **Status:** early MVP and community-maintained. This extension is not an official NaN Builders product unless NaN Builders explicitly adopts or publishes it.

![Setup flow](media/setup.png)

## What works

- Native VS Code language-model provider integration for Chat and Agent mode.
- API-key validation and model discovery through `GET /v1/models`.
- The model picker is filtered by the models available to the configured API key.
- Streaming text and OpenAI-compatible function-tool calls through `POST /v1/chat/completions`.
- Streamed tool calls mapped back to VS Code so supported models can run in Agent mode.
- Image inputs for models whose local metadata advertises vision support.
- API keys stored in VS Code `SecretStorage`, never in workspace settings.
- Remote and WSL workspace support because the provider runs in the local UI extension host.
- Local VS Code session usage in the status bar when the API returns usage metadata.

## Install

### From a release VSIX

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/svg153/nan-vscode/releases).
2. In VS Code run **Extensions: Install from VSIX...**.
3. Reload the window if VS Code asks.

### From source

```bash
npm ci
npm run check
npm run package
```

Install the generated `nan-builders-vscode-*.vsix` with **Extensions: Install from VSIX...**. For interactive development, open the repository in VS Code and press `F5` to launch an Extension Development Host.

## Configure

1. Open the Command Palette.
2. Run **NaN Builders: Manage Provider**.
3. Choose **Set or replace API key** and paste a NaN API key.
4. Choose **Validate API key and refresh models**.
5. In Chat or Agent mode, select a model under the **NaN Builders** provider.

The model picker is intentionally limited to IDs returned by the key's `/v1/models` response. Run **NaN Builders: Refresh Models** after access changes. Provider extensions can also be found with the VS Code Marketplace filter:

```text
@tag:language-models
```

Available settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `nanBuilders.apiBaseUrl` | `https://api.nan.builders/v1` | OpenAI-compatible API base URL. Change only for development or trusted compatible servers. |
| `nanBuilders.modelCacheSeconds` | `300` | Model discovery cache duration. |
| `nanBuilders.showStatusBar` | `true` | Show local session usage in the status bar. |
| `nanBuilders.includeUnknownModels` | `false` | Expose unknown IDs without tool or vision metadata. |

## Agent mode and model metadata

Known NaN chat models advertise tool-calling support and appear in Agent model selection. The extension maps VS Code tools to OpenAI-compatible function tools, handles streamed tool calls, and maps tool names back to the original VS Code tool names.

Only model IDs returned by `/v1/models` are exposed. Known non-chat endpoints are removed. Unknown IDs are hidden by default so an embedding, image, or audio endpoint is not accidentally advertised as a chat model. Set `nanBuilders.includeUnknownModels` to `true` to expose unknown IDs conservatively while local metadata catches up.

VS Code needs context-window, output-budget, image, and tool-calling metadata, while `/v1/models` is the authorization and discovery source. The extension therefore keeps a small local capability catalog and never exposes a catalogued model unless the API key can access it. Refresh the catalog when NaN changes model capabilities.

## Usage and limitations

The status bar is an extension-local counter for the current VS Code session. VS Code does not currently expose a documented usage-reporting callback for third-party chat providers, so account-wide quota is not available here. A future remote-usage feature must use a stable NaN API-key-authenticated endpoint; this extension will not read browser cookies or reuse `nan-cli` sessions.

Inline ghost-text completions are not included yet. VS Code exposes those through the separate `InlineCompletionItemProvider` API; registering a chat provider does not make its models available for inline suggestions. See the roadmap and [issue #8](https://github.com/svg153/nan-vscode/issues/8).

## Architecture

```text
VS Code Chat / Agent
        |
        v
LanguageModelChatProvider
        |
        +--> GET  /v1/models
        |
        +--> POST /v1/chat/completions
                 |  SSE text
                 |  tool calls
                 +  usage
```

No alternate chat webview is created; the provider uses the built-in VS Code Chat and Agent UX.

## Troubleshooting

- **No models appear:** validate the key, then refresh models. Check that the key can call `/v1/models`.
- **A model is missing:** the API key does not currently return that model, or it is a known non-chat endpoint.
- **A request stops without text:** NaN may have hit a reasoning-only truncation; try a shorter prompt or a model with adjustable reasoning.
- **Remote or WSL window:** install the extension in the local UI extension host; a second remote installation should not be required.
- **Key safety:** use **Clear API key** from the management command to remove it from SecretStorage.

## Security

- API keys are stored with VS Code `SecretStorage`, not in settings JSON or the repository.
- The extension does not log API keys.
- Changing `nanBuilders.apiBaseUrl` sends the configured key to that endpoint, so only change it to a server you trust.

## Development and contribution

```bash
npm ci
npm run check       # compile, unit tests, isolated VS Code Insiders test
npm run package     # create a VSIX
```

Commits and pull-request titles use [Conventional Commits](https://www.conventionalcommits.org/). See [`CONTRIBUTING.md`](https://github.com/svg153/nan-vscode/blob/main/CONTRIBUTING.md) for the GSD issue workflow, skills, validation checklist, pull-request expectations, and release process.

Project policy and research live in [`docs/`](https://github.com/svg153/nan-vscode/tree/main/docs):

- [Repository policy](https://github.com/svg153/nan-vscode/blob/main/docs/REPOSITORY.md)
- [Validation checklist](https://github.com/svg153/nan-vscode/blob/main/docs/VALIDATION.md)
- [Provider research](https://github.com/svg153/nan-vscode/blob/main/docs/PROVIDER-RESEARCH.md)
- [Implementation decisions](https://github.com/svg153/nan-vscode/blob/main/docs/DECISIONS.md)
- [Contribution guide](https://github.com/svg153/nan-vscode/blob/main/CONTRIBUTING.md)
- [Release history](https://github.com/svg153/nan-vscode/blob/main/CHANGELOG.md)

## Reference projects

The provider architecture was checked against existing open-source integrations rather than copied wholesale:

- [`huggingface/huggingface-vscode-chat`](https://github.com/huggingface/huggingface-vscode-chat)
- [`JohnnyZ93/oai-compatible-copilot`](https://github.com/JohnnyZ93/oai-compatible-copilot)

`helmcode/nan-cli` is useful as an endpoint and behavior reference. Its code is not copied because no license file was found in its repository root during the initial review.

## Roadmap

1. Add account-wide quota and rolling-window usage when NaN exposes a key-authenticated usage endpoint ([issue #7](https://github.com/svg153/nan-vscode/issues/7)).
2. Add an opt-in, cancellable inline completion provider for low-latency models ([issue #8](https://github.com/svg153/nan-vscode/issues/8)).
3. Evaluate native NaN MCP registration after the core provider is stable.
4. Move capability metadata to server-provided metadata when NaN exposes it.
5. Publish to the VS Code Marketplace only after naming, branding, publisher ownership, and support expectations are agreed with NaN Builders.

## License

MIT. See [`LICENSE`](LICENSE).
