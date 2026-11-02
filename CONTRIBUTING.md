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

CI publishes a lockfile-based dependency audit report with package, severity, dependency type, and installed path. Existing advisories are non-blocking while maintainers triage the baseline; see [`docs/DEPENDENCY-AUDIT.md`](docs/DEPENDENCY-AUDIT.md) before proposing a blocking policy.

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

The release workflow attaches the versioned VSIX to the GitHub Release first, then passes that same VSIX to a separate Marketplace publishing job for `svg153.nan-builders-vscode`. The publishing job is bound to the `marketplace` GitHub Environment and runs only when the repository variable `MARKETPLACE_PUBLISH_ENABLED` is exactly `true`.

- Before enabling `MARKETPLACE_PUBLISH_ENABLED`, a repository administrator must create the `marketplace` environment, add required reviewers, restrict deployments to `main`, and disable administrator bypass where repository policy allows. The workflow reference alone does not configure or enforce those environment rules; until the environment is protected and the variable is enabled, Marketplace publishing is skipped while the GitHub Release still keeps the VSIX.
- Store `VSCE_PAT` as an environment secret on `marketplace`, not as a repository secret. Remove any repository-level `VSCE_PAT`. The publisher job receives it only in the final publish step; the release/build job and CI jobs do not receive it. The token must be an Azure DevOps personal access token with the **Marketplace: Manage** scope for the `svg153` publisher (`vsce verify-pat svg153` runs first). The value is masked in logs and must never be committed or printed.
- The release job gets only `contents: write` for Semantic Release; the publisher job gets `contents: read` and `actions: read` to check out the package manifest and download the VSIX artifact. The VSIX transfer artifact expires after seven days; the GitHub Release asset remains available for recovery.
- If `VSCE_PAT` is missing or rejected, the Marketplace job fails with an explicit error and the GitHub Release VSIX remains available for recovery.
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
