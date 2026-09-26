# Contributing

Thanks for helping improve NaN Builders for VS Code. This repository is community-maintained; please keep changes small, reviewable, and focused on one outcome.

## Before you start

1. Search [open issues](https://github.com/svg153/nan-vscode/issues) before creating a duplicate.
2. For a new outcome, create or update an issue using the repository's [GSD issue skill](.codex/skills/gsd-issues/SKILL.md).
3. Read [`AGENTS.md`](AGENTS.md) for the issue, branch, validation, and PR conventions.

The reusable agent instructions live in `.codex/skills/gsd-issues/SKILL.md`. They define the issue headings, labels, acceptance criteria, and definition of done used by this repository.

## Development workflow

```bash
npm ci
npm run check
npm run package
```

For interactive extension work, open the repository in VS Code and press `F5` to launch an Extension Development Host.

Create a branch named `codex/<short-topic>` and keep commits small. Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/); Husky validates local commits and CI validates the complete PR.

## Pull requests

- Link the issue with `Fixes #N` or `Refs #N`.
- Explain the user-visible result and list validation commands.
- Update README or `docs/` when behavior, configuration, or limitations change.
- Do not include API keys, cookies, personal data, or generated secrets.
- Keep the PR mergeable with the repository ruleset: PR-only changes, required checks, resolved review threads, and squash merge.

All files are covered by `.github/CODEOWNERS`. The repository owner reviews external contributions; the owner may use the configured ruleset bypass for self-authored PRs.

## Releases and documentation

Releases are automated by Semantic Release from `main`. The generated [`CHANGELOG.md`](CHANGELOG.md) records release notes from Conventional Commits; do not edit generated release entries by hand. The version is always read from the package being built; never hard-code a release number.

### Marketplace publishing

The release workflow attaches the versioned VSIX to the GitHub Release first, then publishes the same VSIX to the VS Code Marketplace as `svg153.nan-builders-vscode`:

- The repository secret `VSCE_PAT` must hold an Azure DevOps personal access token with the **Marketplace: Manage** scope for the `svg153` publisher (`vsce verify-pat svg153` runs first). The value is read from the `VSCE_PAT` environment variable, is masked in logs, and must never be committed or printed.
- If `VSCE_PAT` is missing or rejected, the Marketplace step fails with an explicit error and the GitHub Release VSIX remains available for recovery.
- Microsoft Entra ID workload identity federation (`vsce publish --azure-credential`) is the preferred long-term credential once the publisher is linked to Entra ID; global Azure DevOps PATs are scheduled for retirement on 2026-12-01.
- The listing is a community publication under `svg153`; keep README and Marketplace wording accurate about ownership and support.

### Rollback

To withdraw a bad Marketplace release, unpublish that exact version and ship a fix through the normal flow:

```bash
npx vsce unpublish svg153.nan-builders-vscode@<version>
```

Keep the GitHub Release in place as the artifact and audit trail. Never rewrite or delete published Marketplace versions by re-tagging old commits.

### Manual VSIX validation

```bash
npm run check
npm run package
npx vsce ls --no-dependencies
```

Confirm the file list contains only runtime output, branding, README, LICENSE, and `package.json`—no source, tests, CI files, or editor config.

### Disposable-profile smoke test

Install the candidate VSIX into a throwaway profile instead of your daily one:

```bash
code --user-data-dir "$TEMP/nan-vscode-profile" --extensions-dir "$TEMP/nan-vscode-exts" --install-extension nan-builders-vscode-<version>.vsix
```

In that window verify activation, **NaN Builders: Manage Provider**, Chat/Agent model selection, remote-host fallback, and uninstall/reinstall. Delete both temp directories afterwards.

Project policy and research live in [`docs/`](docs/):

- [`docs/REPOSITORY.md`](docs/REPOSITORY.md): merge policy, ruleset, topics, and labels.
- [`docs/VALIDATION.md`](docs/VALIDATION.md): local validation checklist.
- [`docs/PROVIDER-RESEARCH.md`](docs/PROVIDER-RESEARCH.md): provider and VS Code API research.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): implementation decisions.
