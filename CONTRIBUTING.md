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

Releases are automated by Semantic Release from `main`. The generated [`CHANGELOG.md`](CHANGELOG.md) records release notes from Conventional Commits; do not edit generated release entries by hand.

Project policy and research live in [`docs/`](docs/):

- [`docs/REPOSITORY.md`](docs/REPOSITORY.md): merge policy, ruleset, topics, and labels.
- [`docs/VALIDATION.md`](docs/VALIDATION.md): local validation checklist.
- [`docs/PROVIDER-RESEARCH.md`](docs/PROVIDER-RESEARCH.md): provider and VS Code API research.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): implementation decisions.
