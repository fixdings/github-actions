#!/usr/bin/env bash
# Run by actions/review-verify/action.yml. GitHub runs a step `run:` under `bash -e` with pipefail; a
# script invoked as a file gets neither, so it sets them itself.
set -eo pipefail

# The action's own verdict on its process, named if it says the run errored (#113). What
# it answers that nothing else here can: WHY a round produced no usable review.
#
# It belongs on the `failure` branch below and NOWHERE ELSE, which is the opposite of
# where it was first written. In claude-code-action@v1,
# `base-action/src/run-claude-sdk.ts` sets `isSuccess = subtype === "success" &&
# !is_error` and **throws** when that is false; `src/entrypoints/run.ts` catches, sets
# the execution_file output (line 318, BEFORE `core.setFailed`) and fails the action; and
# the composite's `id: run` step carries no `continue-on-error`. So `is_error: true` IS
# `REVIEW_OUTCOME = failure`, always — on the three UNREVIEWED branches further down the
# action judged the run successful, so the record there has `is_error: false` by
# construction and a call would be silent in every reachable state. Read at v1, not
# recalled; an upstream change to that predicate is what would make this wrong.
#
# Only a present transcript naming an error says anything. Absent or empty is the NORMAL
# shape of a failed round — 8 of the 9 failures in the fortnight to 2026-09-08 died
# before Claude started and wrote none — and unreadable must be silent too: this step
# reports on the review, it never fails over its own diagnostics. Same
# slurp/flatten/last idiom as the transcript step (actions/review-transcript), which is what makes it
# indifferent to JSONL vs a JSON array, and `last` for the same reason: a transcript may
# hold more than one result record and the final one is the verdict. Two guards the dump
# step does not need, because a partially written transcript is the shape this fires on:
# `type == "object"`, since `.type` on a bare string aborts the whole filter; and
# `select(. != "")` on the subtype, since `//` substitutes only on null/false and would
# pass an empty string straight through to a message naming nothing.
#
# The subtype is SDK-generated and is an enum in practice, but the transcript is the one
# file in this job whose bytes quote the PR diff, and every other place this step prints
# from it fences with ::stop-commands::. A value carrying a newline or a leading `::`
# would emit workflow commands from inside an annotation, so it is reduced to one safe
# word in jq rather than fenced — a fence for a single enum token is more machinery than
# the risk, and sanitising at the source cannot be forgotten at a second call site.
#
# A FUNCTION so the read happens only where it is printed, and `local` so the one
# variable cannot leak into the rest of the step. Every exit is `return 0` so the
# function is safe to call in ANY position — `note=$(crash_note)` is where a non-zero
# status would abort the step under `bash -e`. (At today's only call site, inside an
# argument to `echo`, the status is discarded and `-e` never sees it; an earlier version
# of this comment claimed otherwise.)
crash_note() {
  local subtype
  [ -n "$EXECUTION_FILE" ] && [ -f "$EXECUTION_FILE" ] || return 0
  subtype=$(jq -sr 'flatten | (map(select(type == "object" and .type == "result")) | last // {})
                    | if .is_error == true then ((.subtype | select(. != "")) // "error") else "" end
                    | gsub("[^A-Za-z0-9_.-]"; "_")' "$EXECUTION_FILE" 2>/dev/null) || return 0
  [ -n "$subtype" ] || return 0
  printf ' The transcript says the run CRASHED (result: %s), so the tail below is the cause and a re-run helps only if it was transient.' "$subtype"
}
# A failed action says the JOB is red; it does not say whether the round was reviewed,
# and this branch must not pretend otherwise in either direction. The old wording
# asserted an infrastructure cause and "re-running will not help"; asserting UNREVIEWED
# instead is the same mistake mirrored, because the action's `if: always()`
# comment-posting step failing AFTER a complete review lands here too — and telling a
# human or watch-pr to re-run a review that is already sitting on the PR is exactly the
# loop the first wording was written to avoid. So: name what can land here, name the
# transcript's verdict when there is one, and send the reader to the PR for the rest.
# The comment/checklist verdict below cannot answer it either — the review step failing
# is not a state those checks were written for, and falling through would report a
# crashed run as "no progress checklist", which is what #113 is about.
if [ "$REVIEW_OUTCOME" = "failure" ]; then
  echo "::error::The review step failed, which is not a verdict on this code. Whether the round was reviewed depends on the cause: an infrastructure problem (token/secret/action), a crash mid-review or a max-turns abort leave it UNREVIEWED and a re-run may help, while a post-review step failing after the review finished leaves a complete review on the PR. Check this run's review comment before re-running.$(crash_note)"
  exit 1
fi
# Match THIS run's comment by author AND the job link it carries:
# claude.yml posts its own tracking comment on the same PR as the same
# bot, every earlier round of THIS workflow left one too, and anyone
# may quote a run URL in a plain comment.
#
# A RE-RUN REUSES THE RUN ID, so a dead attempt leaves a tracking comment that matches
# the run filter below just as well as this attempt does — and `first` then picks the
# dead one forever, which is why a re-run could never go green however well it went
# (run 34423995620 on PR #93: attempt 1 stalled, attempt 2 posted a full review, the
# step still failed citing attempt 1's two unchecked boxes). The comment bodies cannot
# settle it: the action writes the job link and it stops at the run, carrying no
# attempt. So the boundary comes from GitHub's own metadata — any comment older than
# this attempt started belongs to an earlier one.
#
# `run_started_at` on the plain run object ALREADY means "this attempt": it resets on
# re-run, where `created_at` keeps the original. No attempt number is needed, and the
# /attempts/N endpoint was tried first and dropped as the same answer by a longer
# route. Verified on run 34423995620, which has two attempts:
#   run.created_at      = 2026-09-10T01:04:46Z  (attempt 1 — does NOT move)
#   run.run_started_at  = 2026-09-10T01:11:42Z  = attempts/2.run_started_at
# This step only ever runs inside the current attempt, and GitHub refuses to re-run a
# run that is still in progress, so "latest" and "current" cannot diverge here.
#
# Unreadable (lost permission, API change) → no time filter, i.e. exactly the previous
# behaviour, and that is a warning rather than a failure: it only ever matters on a
# re-run, and a first attempt must not start failing over it.
since=$(gh api "repos/$REPO/actions/runs/$RUN_ID" --jq '.run_started_at // empty' 2>/dev/null) || since=""
if [ -z "$since" ]; then
  echo "::warning::Could not read run $RUN_ID's start time, so comments from an earlier attempt cannot be excluded. On a re-run, a stale tracking comment may be read instead of this attempt's."
fi
# EVERY PAGE FROM `since`, the gate's own read (claude-auto-merge step 6). The
# issue-comments endpoint takes no sort or direction, so one unpaged read is the OLDEST
# 100: on a PR past 100 comments this run's comment was never in it and every round
# failed UNREVIEWED, re-run or not. `since=` filters on UPDATE time, so an edited older
# comment can come back — the created_at filter below drops it — but nothing created
# after `since` is ever cut. With no start time, every page is read.
comments=$(gh api --paginate "repos/$REPO/issues/$PR/comments?per_page=100${since:+&since=$since}") || {
  echo "::error::Could not read this PR's comments — the check could not run. This is not a verdict on the review."
  exit 1
}
body=$(printf '%s' "$comments" | jq -rs --arg run "$RUN_ID" --arg since "$since" '
      add // []
      | map(select((.user.login // "") == "claude[bot]"
                or (.user.login // "") == "github-actions[bot]"))
      | map(select((.body // "") | test("actions/runs/" + $run + "([^0-9]|$)")))
      # Drop earlier attempts of the same run. Both timestamps are GitHub-generated
      # ISO-8601 UTC of fixed width, so a string compare is a chronological one; an
      # empty $since means the start time could not be read and nothing is filtered.
      | map(select($since == "" or ((.created_at // "") >= $since)))
      # NO APOSTROPHE anywhere in these comments: the whole program is one
      # single-quoted shell word, so one of them would end it mid-filter.
      # SORTED HERE, not trusted from the API. The tracking comment is opened before
      # Claude starts, so it is the earliest of the comments this run left, and `first`
      # only means that in ascending order. Ordering explicitly makes the selection
      # independent of the endpoint order rather than quietly coupled to it.
      | sort_by(.id)
      # `first`, NOT `last`. `last` instead picked whatever the reviewer posted later
      # through `Bash(gh pr comment:*)`; when that was a "Follow-ups: - [ ] …" list,
      # the awk block below read the follow-up as an unfinished tracker task and
      # called a completed review UNREVIEWED.
      # Position alone, with no "does it look like a tracker" test: a checklist probe
      # here is only a proxy, and when the tracker itself has no checklist it selects
      # the follow-ups comment instead and fails with "1 unchecked task" where the
      # honest answer is the "No progress checklist" error below.
      | first // {} | .body // ""')
if [ -z "$body" ]; then
  # claude-code-action deliberately no-ops on a PR that edits a
  # workflow ("Action skipped due to workflow validation error …
  # your workflow will begin working once you merge your PR") and
  # still exits 0. That PR really is unreviewed, but re-running can
  # never change it, so warn instead of failing every workflow PR.
  # The action's rule is about THIS workflow file only ("must have
  # identical content to the version on the default branch"), so match
  # that exactly — a PR touching some other workflow still gets a real
  # review, and must still be guarded.
  wf="${GITHUB_WORKFLOW_REF#*/}"; wf="${wf#*/}"; wf="${wf%%@*}"
  # Paginated for the same reason as the sensitive-path step: `gh pr view --json files`
  # caps at 100 with no pagination, so on a >100-file PR that also edits this workflow
  # the path sorts past the cap, this branch is missed, and the job hard-fails
  # UNREVIEWED — a red check no re-run can ever clear.
  if gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' | grep -Fxq "$wf"; then
    echo "::warning::UNREVIEWED-BY-DESIGN: this PR edits $wf, which the review action refuses to run against. Review it by hand before merging; re-running will not help."
    exit 0
  fi
  echo "::error::No review comment for run $RUN_ID — this round is UNREVIEWED. Re-run the review; this is not a code failure."
  exit 1
fi
# The progress tracker is every checkbox from the FIRST one up to the next markdown
# HEADING. The terminator used to be "any non-blank, non-checkbox line", which meant a
# single line of prose between two items ended the block there: every item below it
# went uncounted and an UNFINISHED review passed green (#102). A heading terminates it
# instead, so prose between items is tolerated and those items are still counted.
#
# Checkboxes PAST that heading are the review quoting a template or proposing
# follow-ups, and must not fail a review that did finish — the `first`-vs-`last`
# defect the comment selection above was repaired for, one layer down. They are
# reported as a warning rather than dropped, because a silent pass is what #102 was.
# A HEADING here means an ATX heading, and both halves of that are load-bearing: a `#`
# inside a fenced code block is a shell comment, and `#!/bin/sh` is a shebang. Either
# would terminate the tracker early and hand back the very silent pass this fixes — a
# review quoting a diff writes both. So the fence is tracked, and a heading must have
# a space after its hashes. Checkboxes inside a fence are skipped for the same reason
# in reverse: this repo's own test fixtures contain `- [ ]` lines, and a review quoting
# them would otherwise count them and fail a round that finished.
# RESIDUAL, recorded rather than chased: a fence OPENED between two checklist items and
# never closed swallows the rest of the tracker, which is the silent-pass direction. It
# needs the reviewer to write a stray ``` inside its own checklist; every other
# unbalanced-fence position is below the tracker, where it cannot affect the count.
block=$(printf '%s\n' "$body" | awk '
  /^[[:space:]]*```/ { fence = !fence; next }
  !fence && seen && /^[[:space:]]*#+ / { exit }
  !fence && /^[[:space:]]*[-*+] \[[ xX]\]/ { seen=1; print }')
trailing=$(printf '%s\n' "$body" | awk '
  /^[[:space:]]*```/ { fence = !fence; next }
  fence { next }
  seen && /^[[:space:]]*#+ / { after=1 }
  /^[[:space:]]*[-*+] \[ \]/ { if (after) print; seen=1; next }
  /^[[:space:]]*[-*+] \[[xX]\]/ { seen=1 }')
if [ -z "$block" ]; then
  echo "::error::No progress checklist in run $RUN_ID's review comment — track_progress is on, so its absence means the comment is not a completed review (or its format changed). Treating this round as UNREVIEWED rather than passing blind."
  exit 1
fi
unchecked=$(printf '%s\n' "$block" | grep -E '^[[:space:]]*[-*+] \[ \]' || true)
pending=$(printf '%s' "$unchecked" | grep -c . || true)
if [ "$pending" -ne 0 ]; then
  echo "::error::Review did not finish: $pending unchecked task(s) left. This round is UNREVIEWED — re-run the review; this is not a code failure."
  # These lines come from the review body, which quotes the diff and is
  # contributor-controlled, so stop the runner interpreting any
  # ::workflow command:: inside them. Random for the same reason the
  # transcript step's is: a contributor who can guess the closing tag
  # writes one line and turns workflow commands back on for the rest of
  # the job. A nanosecond timestamp is guessable; this is not.
  # The trap is the belt to the explicit close's braces: the default shell is `bash -e`,
  # so anything failing between the two echoes would leave workflow commands DISABLED
  # for the rest of the job with nothing saying so. The transcript step has had
  # this since it was written; these two branches had not (#84). `trap - EXIT` after
  # the close keeps the tag from being emitted twice on the normal path.
  token="stopcmd-$(openssl rand -hex 16)"
  trap 'echo "::${token}::"' EXIT
  echo "::stop-commands::$token"
  printf '%s\n' "$unchecked"
  echo "::$token::"
  trap - EXIT
  exit 1
fi
# Below the tracker, an unchecked box is almost always a proposed follow-up, so this
# never fails the round. It is printed because the alternative — dropping it — is the
# shape of the bug this step was fixed for: if the reviewer split its own checklist
# with a heading, these ARE tracker items and the round is not finished.
extra=$(printf '%s' "$trailing" | grep -c . || true)
if [ "$extra" -ne 0 ]; then
  echo "::warning::$extra unchecked checkbox(es) BELOW the progress checklist. Read as proposed follow-ups, so this does not fail the round — but if the reviewer split its checklist with a heading, they are unfinished tracker items."
  # Contributor-controlled text, fenced exactly as the failure branch above is — trap
  # included, and it matters MORE here: this branch is on the SUCCESS path, so an
  # unclosed fence would silently swallow every workflow command in the rest of a
  # PASSING job, where the failure branch exits immediately after.
  token="stopcmd-$(openssl rand -hex 16)"
  trap 'echo "::${token}::"' EXIT
  echo "::stop-commands::$token"
  printf '%s\n' "$trailing"
  echo "::$token::"
  trap - EXIT
fi
# The verdict is written in the final update only (the prompt's WRITE NO VERDICT rule), so
# a ticked checklist with no verdict line is a review that stopped before that update, and
# one with two is a comment the gate refuses — UNREVIEWED here either way, rather than a
# green run the gate then refuses. The program is the gate's VERDICT_AWK, kept identical
# by tests/workflows.test.mjs, which is why it is not folded into the status pass below.
verdicts=$(printf '%s\n' "$body" | awk '
{ sub(/\r$/, ""); sub(/[[:space:]]+$/, "") }
/^[[:space:]]*```/ { fence = !fence; next }
!fence && /^VERDICT: (CLEAN|BLOCKING [1-9][0-9]*)$/ { print }')
nverdicts=$(printf '%s' "$verdicts" | grep -c . || true)
if [ "$nverdicts" -eq 0 ]; then
  echo "::error::Run $RUN_ID's review comment holds no verdict line — the review stopped before its final update. This round is UNREVIEWED — re-run the review; this is not a code failure."
  exit 1
fi
if [ "$nverdicts" -ne 1 ]; then
  echo "::error::Run $RUN_ID's review comment holds $nverdicts verdict lines — more than one verdict line; the gate refuses it. This round is UNREVIEWED — re-run the review; this is not a code failure."
  exit 1
fi
# The same update swaps the `Reviewing…` status line for a verdict one. The gate never
# reads it, but `watch-pr` and a person do, so every status-shaped line is collected —
# the in-progress one included — and exactly one is allowed: the round this job counted
# and the verdict line's verdict. Its position below the header is not checked: the action
# owns the header layout. A kept `Reviewing…` line, a second copy, a malformed verdict or
# numbers of the reviewer's own all fail here.
statuses=$(printf '%s\n' "$body" | awk '
{ sub(/\r$/, ""); sub(/[[:space:]]+$/, "") }
/^[[:space:]]*```/ { fence = !fence; next }
!fence && /^Round [0-9]+ of [0-9]+ · / { print }')
nstatuses=$(printf '%s' "$statuses" | grep -c . || true)
if [ "$nstatuses" -eq 0 ]; then
  echo "::error::Run $RUN_ID's review comment holds no status line (Round n of b · …), so watch-pr cannot read the round. This round is UNREVIEWED — re-run the review; this is not a code failure."
  exit 1
fi
if [ "$nstatuses" -ne 1 ]; then
  echo "::error::Run $RUN_ID's review comment holds $nstatuses status lines — a Reviewing… line kept beside the swapped one, or a status line repeated. This round is UNREVIEWED — re-run the review; this is not a code failure."
  exit 1
fi
want="Round $ROUND_N of $ROUND_BUDGET · $verdicts"
if [ "$statuses" != "$want" ]; then
  echo "::error::Run $RUN_ID's review comment's status line does not read \"$want\" — the round this job counted and the comment's verdict line. This round is UNREVIEWED — re-run the review; this is not a code failure. The line it holds:"
  # The reviewer's line, fenced as the unchecked tasks are above: it starts `Round `, but
  # a lone \r inside it ends a line for the runner, which would read what follows.
  token="stopcmd-$(openssl rand -hex 16)"
  trap 'echo "::${token}::"' EXIT
  echo "::stop-commands::$token"
  printf '%s\n' "$statuses"
  echo "::$token::"
  trap - EXIT
  exit 1
fi
echo "Review completed: no unchecked tasks, one verdict line and one status line in run $RUN_ID's review comment."
