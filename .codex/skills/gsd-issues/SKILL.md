---
name: gsd-issues
description: Create and execute issue-driven work in nan-vscode using the repository's GSD format, labels, and Conventional Commits.
---

# GSD issues for nan-vscode

Use this skill when turning a request into GitHub work.

## Before creating an issue

- Search open and closed issues for the same outcome.
- Check AGENTS.md and current roadmap.
- Split unrelated outcomes into separate issues.
- Do not create speculative issues without a user-visible goal.

## Issue contract

Use a Conventional Commit title: type(scope): imperative outcome.

The body must contain:

- Context: observed problem or user need.
- Goal: one sentence describing the outcome.
- Scope: files, API surface, and behavior included.
- Non-goals: explicit exclusions.
- Acceptance criteria: testable Given/When/Then checkboxes.
- Validation: commands, integration checks, or manual steps.
- Dependencies: API contracts, other issues, or approvals.
- Definition of done: tests, docs, security, and linked PR.

Apply exactly one type, one area, and one priority label when possible. Current labels are documented in AGENTS.md.

## Implementation loop

1. Create or select the issue.
2. Create codex/<short-topic> from main.
3. Commit small slices with Conventional Commit messages.
4. Run npm run check and npm run package.
5. Open a PR with the same Conventional Commit grammar.
6. Link the issue with Fixes #<number> only when the PR fully closes it.

Keep the scope minimal. If a dependency is not available or an external API contract is missing, record that as a dependency instead of inventing a fallback.
