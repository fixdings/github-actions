#!/usr/bin/env bash
# Run by actions/review-round/action.yml. GitHub ran an inline `run:` under `bash -e` with
# pipefail; a script invoked as a file gets neither, so it sets them itself.
set -eo pipefail

# The workflow's own file, derived the way the verify step derives it, so a repo that
# renames this file still counts its own runs rather than none.
wf="${GITHUB_WORKFLOW_REF#*/}"; wf="${wf#*/}"; wf="${wf%%@*}"
# Every run of this workflow for this PR's branch that was neither CANCELLED nor SKIPPED
# is a round: this one (still in progress, so no conclusion yet) and failed rounds
# alike. Cancelled ones are pushes that superseded each other under cancel-in-progress,
# skipped ones never ran the job — no review happened, so they are not rounds. Runs
# created before the PR was opened belong to an earlier PR on the same branch name.
# `--limit`: gh's default is 20 runs, which a long-lived PR outgrows and would then
# under-count without saying so. A failed list fails the step, loudly: a status line
# with a made-up round would read as true.
count=$(gh run list --repo "$REPO" --workflow "${wf##*/}" --branch "$HEAD_REF" --event pull_request \
      --limit 200 --json conclusion,createdAt --jq '[.[] | select(.conclusion != "cancelled" and .conclusion != "skipped" and .createdAt >= env.PR_CREATED_AT)] | length') || {
  echo "::error::Could not list this workflow's runs, so the review round is unknown. Re-run the review; this is not a verdict on the code."
  exit 1
}
# The list shows a re-run as ONE run (its latest attempt), so this run's earlier
# attempts are added from GITHUB_RUN_ATTEMPT — a default env var on every runner, so
# action.yml passes nothing for it.
# Earlier runs' re-runs stay uncounted: accepted for an informational line.
n=$((count + ${GITHUB_RUN_ATTEMPT:-1} - 1))
# The repo variable is set by `claude-setup github` only while auto-merge is on; unset
# (or anything but a whole number >= 1) means no auto-merge, whose budget is 3 — the
# same rule watch-pr applies when it reads the variable, so the two never disagree.
default_budget=3
case "$BUDGET" in
  ''|0*|*[!0-9]*) budget=$default_budget ;;
  *) budget=$BUDGET ;;
esac
echo "Round $n of $budget."
echo "n=$n" >> "$GITHUB_OUTPUT"
echo "budget=$budget" >> "$GITHUB_OUTPUT"
