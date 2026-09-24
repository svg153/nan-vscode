# Agent workflow for nan-vscode

This repository uses a small GSD (GitHub Spec-Driven) loop for agentic work:

1. Search existing issues before creating a new one.
2. Create one issue for one user-visible outcome.
3. Implement in a branch named codex/<short-topic>.
4. Keep the issue body as the source of truth for scope and acceptance criteria.
5. Open a PR that links the issue, uses a Conventional Commit title, and includes test evidence.

## Issue format

Use a title in this form:

    <type>(<scope>): <imperative outcome>

Allowed types: feat, fix, docs, chore, ci, refactor, perf, test, build.

Use these body headings:

    ## Context
    ## Goal
    ## Scope
    ## Non-goals
    ## Acceptance criteria
    - [ ] Given ... when ... then ...
    ## Validation
    ## Dependencies
    ## Definition of done
    - [ ] Tests/build/docs updated
    - [ ] Secret handling reviewed
    - [ ] PR links this issue

## Labels

Apply one type label (type:feature, type:bug, type:docs, or type:chore), one area label (area:provider, area:usage, area:completion, area:docs, or area:release), and a priority label (priority:p1, priority:p2, or priority:p3). Add good first issue only when the work is genuinely self-contained.

## Commits and PRs

- Commit messages and PR titles must pass Conventional Commits validation.
- Prefer small commits with one logical change.
- Use squash merge; the repository keeps the PR title and PR description as the resulting commit title and body.
- Do not put API keys, session cookies, or real user data in issues, tests, screenshots, or logs.
- Run npm run check and npm run package before requesting review.

The reusable details live in .codex/skills/gsd-issues/SKILL.md.
