---
on:
  issues:
    types: [labeled]

permissions:
  contents: read
  issues: read

network: defaults

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
