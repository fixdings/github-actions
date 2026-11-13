# Sourced, not run: the tracking comment a review run posted, read the same way by the review's
# verify step, the review fixer and the auto-merge gate, so the three can never pick different
# comments for one run.
#
# run_comment REPO PR RUN_ID SINCE — prints the comment as JSON, `{}` when there is none; returns
# non-zero when the read fails, so each caller keeps its own failure handling.
#
# Matched by author AND the job link it carries: claude.yml posts its own tracking comment on the
# same PR as the same bot, every earlier round left one too, and anyone may quote a run URL in a
# plain comment.
#
# EVERY PAGE FROM SINCE, the attempt's `run_started_at`. The issue-comments endpoint takes no sort
# or direction, so one unpaged read is the OLDEST 100: on a PR past 100 comments the run's comment
# would never be in it. `since=` filters on UPDATE time, so an edited older comment can come back
# (the created_at filter drops it) but nothing created after SINCE is ever cut. An empty SINCE
# (the start time could not be read) reads every page and filters nothing.
#
# A RE-RUN REUSES THE RUN ID, so a dead attempt leaves a tracking comment that matches the run
# filter just as well as this attempt's — and `first` then picks the dead one forever (run
# 34423995620 on PR #93: attempt 1 stalled, attempt 2 posted a full review, the step still failed
# citing attempt 1's unchecked boxes). The bodies cannot settle it: the job link stops at the run.
# So the boundary is GitHub's own `run_started_at`, which resets on re-run where `created_at` keeps
# the original — any comment older than it belongs to an earlier attempt.
run_comment() {
  local comments
  comments=$(gh api --paginate "repos/$1/issues/$2/comments?per_page=100${4:+&since=$4}") || return 1
  printf '%s' "$comments" | jq -cs --arg run "$3" --arg since "$4" '
    add // []
    | map(select((.user.login // "") == "claude[bot]" or (.user.login // "") == "github-actions[bot]"))
    | map(select((.body // "") | test("actions/runs/" + $run + "([^0-9]|$)")))
    # Both timestamps are GitHub-generated ISO-8601 UTC of fixed width, so a string compare is a
    # chronological one.
    | map(select($since == "" or ((.created_at // "") >= $since)))
    # NO APOSTROPHE anywhere in these comments: the whole program is one single-quoted shell
    # word, so one of them would end it mid-filter.
    # SORTED HERE, not trusted from the API. The tracking comment is opened before Claude starts,
    # so it is the earliest of the comments the run left, and `first` only means that in
    # ascending order.
    # `first`, NOT `last`: `last` picked whatever the reviewer posted later; when that was a
    # "Follow-ups: - [ ] …" list, the verify step read it as an unfinished tracker and called a
    # completed review UNREVIEWED. Position alone, with no "does it look like a tracker" test.
    | sort_by(.id) | first // {}'
}
