param(
  [string]$Repository = "svg153/nan-vscode"
)

$ErrorActionPreference = "Stop"

# Keep repository policy reproducible; run this with a token that can administer the repository.
gh api --method PATCH "repos/$Repository" --input - @'
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "allow_auto_merge": true
}
'@

$protection = @{
  required_status_checks = @{
    strict = $true
    contexts = @("test", "title", "commits")
  }
  enforce_admins = $true
  required_pull_request_reviews = @{
    dismiss_stale_reviews = $true
    require_code_owner_reviews = $false
    required_approving_review_count = 1
  }
  restrictions = $null
  required_linear_history = $true
  allow_force_pushes = $false
  allow_deletions = $false
  block_creations = $false
  required_conversation_resolution = $true
}
$protection | ConvertTo-Json -Depth 6 | gh api --method PUT "repos/$Repository/branches/main/protection" --input -

$labels = @(
  @{name="type:feature"; color="1d76db"; description="User-visible feature"},
  @{name="type:bug"; color="d73a4a"; description="Defect or regression"},
  @{name="type:docs"; color="0075ca"; description="Documentation"},
  @{name="type:chore"; color="6f42c1"; description="Maintenance or tooling"},
  @{name="area:provider"; color="0e8a16"; description="Chat provider and model discovery"},
  @{name="area:usage"; color="5319e7"; description="Usage and quota"},
  @{name="area:completion"; color="fbca04"; description="Inline completions"},
  @{name="area:docs"; color="cfd3d7"; description="Docs and assets"},
  @{name="area:release"; color="0052cc"; description="Release and repository automation"},
  @{name="priority:p1"; color="b60205"; description="Highest priority"},
  @{name="priority:p2"; color="d93f0b"; description="Normal priority"},
  @{name="priority:p3"; color="0e8a16"; description="Nice to have"}
)
foreach ($label in $labels) {
  gh label create $label.name --repo $Repository --color $label.color --description $label.description --force | Out-Null
}

Write-Output "Configured merge policy, main protection, and GSD labels for $Repository."
