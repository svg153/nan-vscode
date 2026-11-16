---
on:
  schedule: daily
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

network: defaults

# Cost guardrails: the scout reads PRs, issues and diffs, so it needs more
# budget than triage, but nowhere near the 1000 AIC default.
max-ai-credits: 400
max-daily-ai-credits: 400

# Draft (not enabled): run this workflow on OpenAI instead of Copilot.
# Uncomment both lines and add the OPENAI_API_KEY repository secret (or use
# engine id: claude with ANTHROPIC_API_KEY). See
# docs/agentic-pipeline.md#swapping-the-model-provider-draft.
# engine:
#   id: codex
#   model: gpt-5.6-sol

safe-outputs:
  create-issue:
    max: 3

---

# feature-scout

Scan recent repository activity and file at most three high-value improvement
issues, in the repository's GSD format, for work that nobody has proposed yet.

## Instructions

1. Gather context using the GitHub tools (or `gh` via the repository context):
   - Pull requests merged into `main` in the last 7 days (titles, bodies, changed areas).
   - All OPEN issues and all OPEN pull requests (including drafts), with labels.
   - Recent closed-as-`won't`/stalled issues and open questions in issue threads.
2. Infer what the project is currently investing in from merged PRs and open
   work (e.g. VS Code chat provider UI, model providers, NaN Builders
   endpoints, usage/quota surfaces).
3. Identify concrete improvement opportunities that:
   - align with the areas above,
   - are user-visible outcomes, and
   - are NOT already covered by an open issue OR an open pull request.
     Treat an open PR touching the same `area:` as covered — never duplicate
     in-flight parallel work.
4. Rank candidates by user impact and pick at most 3. If none pass the
   deduplication filter, produce no issues and end with a summary of why.
   Skip routine dependency version bumps or "update X to latest" ideas:
   Renovate owns dependency updates with supply-chain cooldowns (see
   `renovate.json`); only propose dependency work for architectural changes
   (e.g. replacing an abandoned package, changing the bundling strategy).
5. For each chosen candidate, create one issue with:
   - Title: `<type>(<scope>): <imperative outcome>` using one of
     feat|fix|docs|chore|ci|refactor|perf|test|build.
   - Body headings exactly: `## Context`, `## Goal`, `## Scope`,
     `## Non-goals`, `## Acceptance criteria` (Given/When/Then checkboxes),
     `## Validation`, `## Dependencies`, `## Definition of done`.
   - Labels: exactly one of `type:feature|type:bug|type:docs|type:chore|type:research`,
     one of `area:provider|area:usage|area:completion|area:docs|area:release|area:governance`,
     and one of `priority:p1|priority:p2|priority:p3`.
   - Do NOT add the `agent:ready` label; humans decide what enters the
     Copilot implementation queue.

## Constraints

- Never include API keys, session data, or real user data in issue bodies.
- Never comment on or modify existing issues; the only write action is issue creation.
- Keep each issue self-contained so the Copilot coding agent can implement it
  without extra conversation.

## Notes

- Compiled with `gh aw compile`; do not edit `feature-scout.lock.yml` directly.
