# Sourced, not run: the `needs-human` label, put on a PR the same way by the review fixer and the
# auto-merge gate — the one label watch-pr and a person look for.
NEEDS_HUMAN_LABEL=needs-human
NEEDS_HUMAN_COLOR=d93f0b
NEEDS_HUMAN_DESCRIPTION="Waiting on a person — see the needs-human comment"

# label_needs_human PR — labels the PR, creating the label first in a repo that has none. Never
# fails: the comment beside it already says what to do, so a missing label is a warning.
label_needs_human() {
  if ! gh pr edit "$1" --add-label "$NEEDS_HUMAN_LABEL"; then
    gh label create "$NEEDS_HUMAN_LABEL" --color "$NEEDS_HUMAN_COLOR" --description "$NEEDS_HUMAN_DESCRIPTION" || true
    gh pr edit "$1" --add-label "$NEEDS_HUMAN_LABEL" || echo "::warning::Could not label PR #$1."
  fi
}
