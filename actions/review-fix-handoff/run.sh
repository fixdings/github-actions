#!/usr/bin/env bash
# Run by actions/review-fix-handoff/action.yml. GitHub ran an inline `run:` under `bash -e` with
# pipefail; a script invoked as a file gets neither, so it sets them itself.
set -eo pipefail
# Shared with the other actions: actions/lib/, in the same sparse checkout.
. "$GITHUB_ACTION_PATH/../lib/needs-human.sh"

f=$(mktemp)
if [ -s "$HANDOFF" ]; then
  {
    printf '**Not fixed: needs-human — a blocking finding needs a change under `.github/workflows/`, which this fixer may not commit.**\n\n'
    cat "$HANDOFF"
    printf '\n\n**What to do:** apply the diff yourself and push, or comment `@claude apply this` to have claude.yml commit it.\n'
  } > "$f"
else
  # An unreadable head counts as unmoved: a stray label is cheaper than a silent stall.
  head=$(gh api "repos/$GH_REPO/pulls/$PR" --jq .head.sha) || head="$HEAD_SHA"
  [ "$head" = "$HEAD_SHA" ] || exit 0
  printf '**Not fixed: needs-human — the fixer committed nothing for review round %s, so no next round will start.**\n\nIts reasons, if it gave any, are in the comment above; otherwise see the fix run: %s\n\n**What to do:** fix or decline the open findings yourself and push, or merge as it stands.\n' \
    "$ROUND" "$GITHUB_SERVER_URL/$GH_REPO/actions/runs/$GITHUB_RUN_ID" > "$f"
fi
gh pr comment "$PR" --body-file "$f" || echo "::warning::Could not comment on PR #$PR."
label_needs_human "$PR"
