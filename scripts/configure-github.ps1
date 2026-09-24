param(
  [string]$Repository = "svg153/nan-vscode"
)

$ErrorActionPreference = "Stop"

# Keep repository policy reproducible; run this with a token that can administer the repository.
$mergeSettings = @{
  allow_squash_merge = $true
  allow_merge_commit = $false
  allow_rebase_merge = $false
  squash_merge_commit_title = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"
  delete_branch_on_merge = $true
  allow_auto_merge = $true
} | ConvertTo-Json
$mergeSettings | gh api --method PATCH "repos/$Repository" --input - | Out-Null

$metadata = @{
  description = "Community-maintained VS Code language model provider for NaN Builders Chat and Agent mode."
  homepage = "https://github.com/svg153/nan-vscode#readme"
} | ConvertTo-Json
$metadata | gh api --method PATCH "repos/$Repository" --input - | Out-Null

$topics = @{
  names = @("vscode-extension", "language-model", "ai", "chat", "agent", "nan-builders", "openai-compatible", "typescript")
} | ConvertTo-Json
$topics | gh api --method PUT "repos/$Repository/topics" --input - | Out-Null

# Rulesets are the source of truth for main. This is idempotent by name.
$rulesetName = "main-pull-request"
$ownerId = [int](gh api user --jq .id)
$ruleset = @{
  name = $rulesetName
  target = "branch"
  enforcement = "active"
  conditions = @{
    ref_name = @{
      include = @("refs/heads/main")
      exclude = @()
    }
  }
  rules = @(
    @{type = "deletion"},
    @{type = "non_fast_forward"},
    @{type = "required_linear_history"},
    @{type = "pull_request"; parameters = @{
      dismiss_stale_reviews_on_push = $true
      require_code_owner_review = $true
      require_last_push_approval = $false
      required_approving_review_count = 1
      required_review_thread_resolution = $true
      allowed_merge_methods = @("squash")
    }},
    @{type = "required_status_checks"; parameters = @{
      strict_required_status_checks_policy = $true
      do_not_enforce_on_create = $false
      required_status_checks = @(
        @{context = "test"; integration_id = 15368},
        @{context = "title"},
        @{context = "commits"}
      )
    }}
  )
  # The authenticated repository owner may merge their own PR without a second review.
  bypass_actors = @(@{actor_id = $ownerId; actor_type = "User"; bypass_mode = "pull_request"})
} | ConvertTo-Json -Depth 10

$existingRuleset = (gh api "repos/$Repository/rulesets" | ConvertFrom-Json | Where-Object name -eq $rulesetName | Select-Object -First 1)
if ($existingRuleset) {
  $ruleset | gh api --method PUT "repos/$Repository/rulesets/$($existingRuleset.id)" --input - | Out-Null
} else {
  $ruleset | gh api --method POST "repos/$Repository/rulesets" --input - | Out-Null
}

# Remove the legacy protection if it still exists so policy is not split across two systems.
gh api --method DELETE "repos/$Repository/branches/main/protection" 2>$null | Out-Null

$labels = @(
  @{name="type:feature"; color="1d76db"; description="User-visible feature"},
  @{name="type:bug"; color="d73a4a"; description="Defect or regression"},
  @{name="type:docs"; color="0075ca"; description="Documentation"},
  @{name="type:chore"; color="6f42c1"; description="Maintenance or tooling"},
  @{name="type:research"; color="d4c5f9"; description="Investigation or proof of concept"},
  @{name="area:provider"; color="0e8a16"; description="Chat provider and model discovery"},
  @{name="area:usage"; color="5319e7"; description="Usage and quota"},
  @{name="area:completion"; color="fbca04"; description="Inline completions"},
  @{name="area:docs"; color="cfd3d7"; description="Docs and assets"},
  @{name="area:release"; color="0052cc"; description="Release and repository automation"},
  @{name="area:governance"; color="5319e7"; description="Repository policy and agent workflow"},
  @{name="priority:p1"; color="b60205"; description="Highest priority"},
  @{name="priority:p2"; color="d93f0b"; description="Normal priority"},
  @{name="priority:p3"; color="0e8a16"; description="Nice to have"}
)
foreach ($label in $labels) {
  gh label create $label.name --repo $Repository --color $label.color --description $label.description --force | Out-Null
}

Write-Output "Configured merge policy, main ruleset, metadata, topics, and GSD labels for $Repository."
