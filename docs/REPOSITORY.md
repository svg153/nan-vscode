# Repository policy

The repository is configured for a small, PR-first workflow:

- `main` is governed by the active `main-pull-request` ruleset.
- Changes require a pull request, one approval, resolved review threads, the `test`, `title`, and `commits` checks, and linear history.
- Force-pushes, branch deletion, and direct merge commits are disabled.
- Pull requests are squash-merged with the PR title and description.
- Merged branches are deleted automatically.
- `.github/CODEOWNERS` assigns the whole repository to `@svg153`.
- Code-owner review is required for contributors; the repository owner has an explicit pull-request bypass for self-authored PRs.
- Repository description and topics identify this as a community-maintained VS Code language-model provider.

Run `scripts/configure-github.ps1` with repository-admin access to reconcile the policy and GSD labels. The script is intentionally idempotent by ruleset name.

Contribution flow, issue skills, release notes, and validation expectations are documented in [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`AGENTS.md`](../AGENTS.md), and [`CHANGELOG.md`](../CHANGELOG.md).

## Labels

Use one label from each group:

- **Type:** `type:feature`, `type:bug`, `type:docs`, `type:chore`, `type:research`
- **Area:** `area:provider`, `area:usage`, `area:completion`, `area:docs`, `area:release`, `area:governance`
- **Priority:** `priority:p1`, `priority:p2`, `priority:p3`

GitHub's default labels remain available for compatibility; new work should use the scoped labels above.
