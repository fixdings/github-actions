#!/usr/bin/env bash
# Run by actions/review-sensitive-paths/action.yml. GitHub runs a step `run:` under `bash -e` with pipefail; a
# script invoked as a file gets neither, so it sets them itself.
set -eo pipefail

# Keep in sync with the prompt's list and with claude-code-action's SENSITIVE_PATHS.
sensitive=".claude .mcp.json .claude.json .gitmodules .ripgreprc CLAUDE.md CLAUDE.local.md .husky"
# NOT `gh pr view --json files`: that is GraphQL `files(first: 100)` with no pagination,
# so on a >100-file PR whose config edits sort past the cap this prints "edits none" —
# a silent false negative on the one check whose entire value is detection.
# per_page rides in the QUERY STRING, never as `-F per_page=100`: `gh api` switches the
# method to POST as soon as any parameter is added, and POST to this endpoint is a 404.
# Measured — that spelling failed run 34486242726 on this very PR.
files=$(gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename') || {
  echo "::warning::Could not list this PR's files, so the sensitive-path check did not run. This is not a verdict on the review."
  exit 0
}
# Exact path or a child of it: a bare substring test would report `.claude` for
# `.claude.json` and vice versa, and both are on the list anyway.
hits=$(printf '%s\n' "$files" | awk -v list="$sensitive" '
  BEGIN { n = split(list, s, " ") }
  { for (i = 1; i <= n; i++) if ($0 == s[i] || index($0, s[i] "/") == 1) { print s[i]; break } }
' | sort -u | tr '\n' ' ')
if [ -n "$hits" ]; then
  echo "::warning::REVIEWED-FROM-BASE: this PR edits $hits, which the action replaces with the base branch's versions before the review starts. The reviewer is told to read .claude-pr/ instead, but double-check any finding about those paths by hand."
else
  echo "This PR edits none of the restored config paths."
fi
