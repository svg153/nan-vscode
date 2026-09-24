# MVP validation checklist

This is the validation pass for the first provider release. Unit tests cover the stream decoder, model catalog, and tool-name mapping. `npm run test:insiders` exercises discovery and streamed chat through the actual VS Code Insiders Language Model API using a local mock server; it does not use a real key. A separate live check against NaN is still required before Marketplace publication.

## Build

```bash
npm install
npm run check
npm run package
```

Expected: TypeScript compilation, unit tests, and VSIX packaging all complete successfully.

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
5. Compare the picker with `GET /v1/models` for the same key. Every known chat ID returned there should be offered: `deepseek-v4-flash`, `glm5.3-flash`, `qwen3.8-flash`, `mimo-v2.5`, `gemma4`, `qwen3.6`, and, for premium keys, `glm5.3`. Models absent from `/v1/models` must stay absent from the picker.
6. Confirm known non-chat IDs such as embeddings, rerank, audio, and image generation are not exposed as chat models.

Important: treat `/v1/models` as the definitive API-key-filtered list. A model must not be exposed just because it exists in the local metadata catalog. In particular, `glm5.3` should only appear for keys whose `/v1/models` response contains it.

## Basic streaming chat

Run a short prompt with `deepseek-v4-flash`:

```text
Reply with exactly: NAN_OK
```

Expected: text appears progressively and finishes with `NAN_OK`.

Repeat with `glm5.3-flash`.

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

## Cancellation

Start a long request and cancel it from Chat.

Expected: the HTTP stream is aborted and no further text or tool calls appear.

## Usage

Make at least one request from VS Code.

Expected: the status bar shows `NaN` and local token usage when the API returns streaming usage metadata. The tooltip must state that this is local VS Code session usage, not the account-wide NaN quota.

## Remote and WSL behavior

Open a WSL workspace with the extension installed locally.

Expected: the provider remains available without requiring a second installation inside WSL, because the extension is declared as a UI extension.

## Exit criteria

The MVP is ready for a first tagged pre-release when all checks above pass on current stable VS Code and no API key or session secret appears in logs or workspace files.
