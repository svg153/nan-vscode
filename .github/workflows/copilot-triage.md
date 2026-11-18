---
on:
  issues:
    types: [labeled]

permissions:
  contents: read
  issues: read

network: defaults

# gh-aw v1.3.x routes model selection by default (`goal: cost`, `mode: auto`)
# when a workflow pins no model. Keep the pre-upgrade behavior: one fixed
# engine/model per workflow, chosen by `GH_AW_MODEL_*` repository variables if
# set, so triage cost and output stay predictable.
engine:
  id: copilot
  model-routing: false

# Cost guardrails: a triage run is a label check plus one assignment. The
# default budget (1000 AIC = $10) is far above what this needs, so cap it.
max-ai-credits: 150
max-daily-ai-credits: 300

# Not a provider-swap candidate: this workflow hands work to the Copilot coding
# agent through `safe-outputs: assign-to-agent`, so Copilot is load-bearing here
# and the engine has to stay on it. If that hand-off is ever removed, the swap
# target is the NaN Builders gateway (see feature-scout.md for the same draft):
# engine id: codex with OPENAI_BASE_URL, model deepseek-v4-flash, secret
# OPENAI_API_KEY, and api.nan.builders allowed in network.

safe-outputs:
  assign-to-agent:
    name: copilot
    required-labels: [agent:ready]
  add-comment:
    max: 1

---

# copilot-triage

Hand issues that a maintainer has approved for automation to the GitHub Copilot
coding agent, which will open the implementation pull request in the cloud.

## Instructions

1. This workflow fires on every label added to an issue. Check the triggering
   label: if it is NOT `agent:ready`, stop and do nothing.
2. When the label IS `agent:ready`, verify the issue is ready for autonomous
   implementation:
   - It has exactly one `type:*`, one `area:*` and one `priority:*` label.
   - Its body contains `## Acceptance criteria` with at least one
     Given/When/Then item and a `## Validation` section.
3. If the issue is not ready, add one short comment listing the missing parts
   and stop. Do not assign the agent.
4. If the issue is ready, assign it to the Copilot coding agent so it starts a
   cloud session that implements the change, opens a pull request linked to
   the issue, and reacts to review feedback.

## Constraints

- One issue equals one user-visible outcome; if the issue clearly bundles
  several outcomes, comment asking to split it instead of assigning.
- Never edit the issue title, body, or other labels.
- Never open pull requests from this workflow; only the Copilot coding agent
  session does that.

## Notes

- The merge gate stays human: CI (`npm run check`, VS Code Insiders
  integration) plus your approval of the Copilot code review. After approval,
  enable auto-merge (squash) on the PR.
- Compiled with `gh aw compile`; do not edit `copilot-triage.lock.yml` directly.
