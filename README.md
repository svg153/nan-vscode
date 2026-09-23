# NaN Builders for VS Code

A native VS Code language model provider for [NaN Builders](https://nan.builders). It makes models exposed by the NaN OpenAI-compatible API available in the built-in VS Code Chat and Agent model picker.

> Status: early MVP. This repository is community-maintained and is not an official NaN Builders extension unless NaN Builders explicitly adopts or publishes it.

## What works

- Native `languageModelChatProviders` integration, so the extension is discoverable as a VS Code language model provider.
- API key stored in VS Code `SecretStorage`.
- API-key validation and model discovery through `GET https://api.nan.builders/v1/models`.
- The model picker follows the API-key-filtered list returned by NaN, so premium-only models appear only when the key can actually call them.
- Streaming chat through `POST https://api.nan.builders/v1/chat/completions`.
- VS Code tool definitions mapped to OpenAI-compatible function tools.
- Streamed tool calls mapped back to VS Code so supported NaN models can run in Agent mode.
- Image inputs for catalogued vision-capable models.
- Local status-bar usage when the API returns OpenAI-compatible streaming usage metadata.
- Conservative handling of newly discovered model IDs that are not yet in the local metadata catalog.

## Install for development

```bash
npm install
npm run check
npm run package
```

Install the generated `.vsix` from VS Code with **Extensions: Install from VSIX...**.

For normal extension debugging, open the repository in VS Code and press `F5` to launch an Extension Development Host.

## Configure

1. Open the Command Palette.
2. Run **NaN Builders: Manage Provider**.
3. Choose **Set or replace API key** and paste a NaN API key.
4. The key is stored in VS Code `SecretStorage` and validated against `/v1/models`. NaN documents this endpoint as the definitive list filtered by what the key can call.
5. Open Chat, select **Manage Language Models**, and choose one of the NaN Builders models.

You can also find provider extensions with the Marketplace filter:

```text
@tag:language-models
```

## Agent mode

Known NaN chat models are marked as supporting tool calling and appear in Agent model selection. The extension maps VS Code tools to OpenAI-compatible function tools, handles streamed tool calls, and maps the tool name back to the original VS Code tool name.

Only model IDs returned by `/v1/models` are exposed. Known non-chat endpoints are removed. Unknown IDs are hidden by default because a newly added embedding, image, audio, or other endpoint must not accidentally be advertised as a chat model. You can set `nanBuilders.includeUnknownModels` to `true` to expose unknown IDs conservatively, without tool calling or vision, while waiting for the extension metadata to catch up.

## Usage

The status bar shows usage returned by requests made through this VS Code session. It is intentionally labeled local session usage.

Account-wide NaN usage currently comes from a separate authenticated cloud endpoint and is not exposed through the inference API key used by this extension. The extension does not read browser cookies or reuse the `nan-cli` web session. A future NaN API endpoint authenticated by the inference key would allow account-wide quota and rolling-window usage to be added cleanly.

## Model metadata

VS Code needs context-window, output-budget, image, and tool-calling metadata, while `/v1/models` currently provides the IDs that the API key can use. The extension therefore treats `/v1/models` as the authorization/discovery source and keeps a local metadata catalog only for capabilities. A model is never exposed merely because it exists in that catalog. Unknown IDs are hidden by default and can be enabled conservatively if needed.

The current catalog is based on the public NaN configuration available in September 2026. It should be refreshed whenever NaN changes model capabilities.

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

No alternate chat webview is created. The goal is to use the built-in VS Code Chat and Agent UX.

## Reference projects

The implementation is intentionally small and focused on NaN, but the provider architecture was validated against these existing MIT projects instead of reinventing the integration pattern:

- `huggingface/huggingface-vscode-chat`
- `JohnnyZ93/oai-compatible-copilot`

`helmcode/nan-cli` is useful as a behavior and endpoint reference. Code is not copied from it because no license file was found in the repository root during the initial review.

## Security

- API keys are stored with VS Code `SecretStorage`, not in settings JSON or the repository.
- The extension does not log API keys.
- Changing `nanBuilders.apiBaseUrl` sends the configured key to that endpoint, so only change it to a server you trust.

## Roadmap

1. Validate the provider end-to-end against a real NaN account and all currently exposed chat models.
2. Add account-wide quota and rolling-window usage when NaN exposes a key-authenticated usage endpoint.
3. Evaluate native NaN MCP registration after the core provider is stable.
4. Move model capability metadata to server-provided metadata when NaN exposes it.
5. Publish to the VS Code Marketplace only after naming, branding, publisher ownership, and support expectations are agreed with NaN Builders.

## License

MIT.
