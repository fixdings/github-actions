# github-actions

Reusable GitHub Actions workflows for the Claude Code integration.

| Workflow | Caller trigger | What it does |
|---|---|---|
| `reusable-claude.yml` | `issue_comment`, `pull_request_review_comment` | Runs Claude when a comment says `@claude`. |
| `reusable-claude-code-review.yml` | `pull_request` | Reviews the PR and ends on `Round <n> of <budget> · VERDICT: CLEAN \| BLOCKING <k>`. |
| `reusable-claude-review-fix.yml` | `workflow_run` of the review | Fixes a blocking round on a PR Claude opened. |
| `reusable-claude-auto-merge.yml` | `workflow_run` of the review | Merges a PR whose review is CLEAN, or labels it `needs-human`. |

`fixdings/claude-setup` (`node cli/setup.mjs github`) installs the callers. A caller looks like:

```yaml
name: Claude Auto Review with Tracking
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
concurrency:
  group: claude-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    permissions:
      contents: read
      pull-requests: write
      issues: read
      id-token: write
      actions: read
    uses: fixdings/github-actions/.github/workflows/reusable-claude-code-review.yml@v1
    with:
      round-budget: ${{ vars.CLAUDE_CODE_REVIEW_ROUND_BUDGET }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The calling repo needs the Claude GitHub App installed and a `CLAUDE_CODE_OAUTH_TOKEN` secret.
