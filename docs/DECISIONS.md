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

**Decision:** The MVP shows local VS Code session usage from streamed API usage metadata. Account-wide quota is deferred until there is a clean key-authenticated API or a separately reviewed account-login feature.

## AUTONOMOUS-DECISION: Marketplace branding remains community-scoped

**Question:** Should the first package present itself as an official NaN Builders extension?

**Decision:** No. The code can use the descriptive name `NaN Builders for VS Code`, but documentation states that it is community-maintained unless NaN Builders explicitly adopts or publishes it. Marketplace publisher ownership and official branding need explicit agreement before public release.
