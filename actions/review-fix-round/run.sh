#!/usr/bin/env bash
# Run by actions/review-fix-round/action.yml. GitHub ran an inline `run:` under `bash -e` with
# pipefail; a script invoked as a file gets neither, so it sets them itself.
set -eo pipefail
# Shared with the other actions: actions/lib/, in the same sparse checkout.
. "$GITHUB_ACTION_PATH/../lib/run-comment.sh"
. "$GITHUB_ACTION_PATH/../lib/needs-human.sh"

# The author is the whole scope rule: a branch name is anyone-with-push's to choose,
# the PR's author is not. A moved head has its own review coming; a closed PR is done.
pr=$(gh api "repos/$GH_REPO/pulls/$PR" --jq '[.state, .head.sha, .user.login] | @tsv')
IFS=$'\t' read -r pr_state pr_head pr_author <<< "$pr"
if [ "$pr_author" != "$CLAUDE_BOT" ]; then
  echo "Skipped: PR #$PR was opened by $pr_author, not $CLAUDE_BOT, so its author answers the review."
  exit 0
fi
if [ "$pr_state" != open ] || [ "$pr_head" != "$HEAD_SHA" ]; then
  echo "Skipped: PR #$PR is $pr_state and its head moved=$([ "$pr_head" != "$HEAD_SHA" ] && echo yes || echo no)."
  exit 0
fi

# The review run's tracking comment, selected as the gate and the verify step select it
# (actions/lib/run-comment.sh). A failed read fails the step, loudly.
review=$(run_comment "$GH_REPO" "$PR" "$RUN_ID" "$RUN_STARTED_AT")
body=$(printf '%s' "$review" | jq -r '.body // ""')
url=$(printf '%s' "$review" | jq -r '.html_url // ""')

# The status line, outside code fences. `.+` stands in for the middle dot so the match
# does not depend on the runner locale reading UTF-8.
status=$(printf '%s\n' "$body" | awk '
  { sub(/\r$/, ""); sub(/[[:space:]]+$/, "") }
  /^[[:space:]]*```/ { fence = !fence; next }
  !fence && /^Round [0-9]+ of [0-9]+ .+ VERDICT: (CLEAN|BLOCKING [1-9][0-9]*)$/ { print }')
if [ "$(printf '%s' "$status" | grep -c .)" -ne 1 ]; then
  echo "::warning::Review run $RUN_ID left no single status line, so there is nothing to fix from. The gate reports the review itself."
  exit 0
fi
read -r _ n _ budget _ _ verdict blocking <<< "$status"
if [ "$verdict" = CLEAN ]; then
  echo "Round $n of $budget is CLEAN: nothing to fix."
  exit 0
fi

if [ "$n" -ge "$budget" ]; then
  f=$(mktemp)
  printf '**Not fixed: budget spent — round %s of %s still has %s blocking finding(s).**\n\nThe fixer stops at the review budget (`CLAUDE_CODE_REVIEW_ROUND_BUDGET`, else 3). Last review: %s\n\n**What to do:** fix or decline the findings yourself and push, or merge as it stands.\n' \
    "$n" "$budget" "$blocking" "$url" > "$f"
  gh pr comment "$PR" --body-file "$f" || echo "::warning::Could not comment on PR #$PR."
  label_needs_human "$PR"
  echo "Round $n of $budget: budget spent, handed to a person."
  exit 0
fi

# The review body goes to Claude as a file, never through an expression: it quotes the
# diff, and an expression would paste it into the prompt unescaped.
printf '%s\n' "$body" > "$RUNNER_TEMP/review-round.md"
{
  echo "fix=yes"
  echo "n=$n"
  echo "budget=$budget"
  echo "blocking=$blocking"
} >> "$GITHUB_OUTPUT"
