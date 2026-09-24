# NaN Builders for VS Code

[![CI](https://github.com/svg153/nan-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/svg153/nan-vscode/actions/workflows/ci.yml)
[![Release](https://github.com/svg153/nan-vscode/actions/workflows/release.yml/badge.svg)](https://github.com/svg153/nan-vscode/actions/workflows/release.yml)

Use [NaN Builders](https://nan.builders/) models in VS Code Chat and Agent mode through the native `LanguageModelChatProvider` API.

> **Status:** community-maintained. This extension is not an official NaN Builders product.

![Setup flow](media/setup.png)

## What it does

- Discovers the models available to the configured API key from `/v1/models`.
- Streams text and OpenAI-compatible tool calls into VS Code Chat and Agent mode.
- Supports image input for models whose local metadata advertises vision.
- Stores the API key in VS Code `SecretStorage`, never in workspace settings.
- Works from remote and WSL workspaces because the provider runs as a UI extension.
- Shows **local VS Code session usage** in the status bar when the API returns usage metadata.

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

Install the generated `nan-builders-vscode-*.vsix` with **Extensions: Install from VSIX...**.

## Configure

1. Open the Command Palette.
2. Run **NaN Builders: Manage Provider**.
3. Choose **Set or replace API key** and paste the key.
4. Choose **Validate API key and refresh models**.
5. In Chat or Agent mode, select a model under the **NaN Builders** provider.

The model picker is intentionally limited to IDs returned by the key's `/v1/models` response. Refresh it with **NaN Builders: Refresh Models** after access changes.

Available settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `nanBuilders.apiBaseUrl` | `https://api.nan.builders/v1` | OpenAI-compatible API base URL. |
| `nanBuilders.modelCacheSeconds` | `300` | Model discovery cache duration. |
| `nanBuilders.showStatusBar` | `true` | Show local session usage in the status bar. |
| `nanBuilders.includeUnknownModels` | `false` | Opt in to unknown IDs without tools or vision. |

## Usage and limitations

The status bar is an extension-local counter for the current VS Code session. VS Code does not currently expose a documented usage-reporting callback for third-party chat providers, so the extension cannot present an account-wide quota by itself. A future remote-usage feature must use a stable NaN API-key-authenticated endpoint; it will not read browser cookies or `nan-cli` sessions.

Inline ghost-text completions are not included yet. VS Code exposes those through the separate `InlineCompletionItemProvider` API; registering a chat provider does not make its models available for inline suggestions. See the roadmap for the planned, opt-in implementation.

## Troubleshooting

- **No models appear:** validate the key, then refresh models. Check that the key can call `/v1/models`.
- **A model is missing:** the API key does not currently return that model, or it is a known non-chat endpoint.
- **A request stops without text:** NaN may have hit a reasoning-only truncation; try a shorter prompt or a model with adjustable reasoning.
- **Remote or WSL window:** install the extension in the local UI extension host; a second remote installation should not be required.
- **Key safety:** use **Clear API key** from the management command to remove it from SecretStorage.

## Development

```bash
npm ci
npm run check       # compile, unit tests, isolated VS Code Insiders test
npm run package     # create a VSIX
```

Commits and pull-request titles use [Conventional Commits](https://www.conventionalcommits.org/). Local hooks are installed by `npm ci`; CI validates both the PR title and all commits. Releases are created automatically from `main` by Semantic Release when a `feat:` or `fix:` commit warrants a version bump.

Issue and PR work follows the repository's [GSD issue workflow](AGENTS.md). The full validation checklist is in [docs/VALIDATION.md](https://github.com/svg153/nan-vscode/blob/main/docs/VALIDATION.md), and implementation decisions are in [docs/DECISIONS.md](https://github.com/svg153/nan-vscode/blob/main/docs/DECISIONS.md).

Repository merge policy, ruleset, topics, and labels are documented in [docs/REPOSITORY.md](https://github.com/svg153/nan-vscode/blob/main/docs/REPOSITORY.md).

The provider/API comparison and future capability boundaries are documented in [docs/PROVIDER-RESEARCH.md](https://github.com/svg153/nan-vscode/blob/main/docs/PROVIDER-RESEARCH.md).

## Roadmap

- Account-wide usage from a documented NaN API-key endpoint.
- An opt-in, cancellable inline completion provider for low-latency models.
- A short recorded setup walkthrough once the UI and branding are stable.

See the [open issues](https://github.com/svg153/nan-vscode/issues) for scoped acceptance criteria.

## License

MIT. See [`LICENSE`](LICENSE).
