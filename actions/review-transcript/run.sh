#!/usr/bin/env bash
# Run by actions/review-transcript/action.yml. GitHub runs a step `run:` under `bash -e` with pipefail; a
# script invoked as a file gets neither, so it sets them itself.
set -eo pipefail

# Reaching here means the action DID set a path (the step `if` requires it) and the
# file is not there — cleaned up, or written somewhere else. "Claude never ran" is
# the one explanation already ruled out, so don't print it.
if [ ! -f "$EXECUTION_FILE" ]; then
  echo "The action reported a transcript at $EXECUTION_FILE, but no such file exists."
  exit 0
fi
# The transcript quotes the PR diff, which is contributor-controlled,
# so stop the runner interpreting any ::workflow command:: inside it.
# The default shell is `bash -e`: close the fence from a trap, or a jq
# that dies on a half-written transcript (the action killed mid-write
# by cancel-in-progress, a timeout, an OOM) leaves workflow commands
# disabled for every later step in the job.
# Random for the same reason as the verify step's (actions/review-verify), and more so: what
# this fences is the whole transcript, quoting the PR diff verbatim, so a
# contributor writes a large share of the bytes.
token="stopcmd-$(openssl rand -hex 16)"
trap 'echo "::${token}::"' EXIT
echo "::stop-commands::$token"
# -s + flatten reads all three shapes identically: the JSON array the
# action writes, a bare object, and a newline-delimited stream. Without
# it jq runs the filter once per top-level document, repeating the
# header for every message. Messages are objects, so flatten only ever
# unwraps the slurp's own outer array.
#
# The verdict line is the whole point of the step, so print it whole.
# Only the transcript body below it is capped, and `tail -c` keeps the
# END of a run — where a review that stopped early stopped.
# ONE pass for both halves (#84). The verdict and the last assistant message came from
# two `jq -s` runs over the same file; slurping a transcript twice to answer two
# questions about it is the kind of thing nobody notices because the step only runs on
# a failed round.
#
# The second half is the last assistant message that HAS text: when a run dies at
# --max-turns the final message is usually tool_use only, and that is the case this
# step exists to explain. `content` is normally an array of blocks, but a plain string
# is also valid and would abort `map`.
#
# Splitting one jq output back into two shell values needs a boundary the payload
# cannot contain, so the marker is the run's own random token — the same one already
# fencing this output. A literal sentinel would be forgeable by a contributor writing
# it into the PR diff, which the transcript quotes verbatim.
if ! out=$(jq -sr --arg sep "$token" 'flatten
        | (map(select(.type == "result")) | last // {}) as $r
        | [ .[]
            | select(.type == "assistant")
            | (.message.content // [])
            | if type == "array"
              then map(select(.type == "text") | .text // "") | join("\n")
              else . end ]
        | (map(select(. != "")) | last // "(no assistant text in transcript)") as $body
        | "subtype=\($r.subtype // "n/a") is_error=\(if ($r | has("is_error")) then $r.is_error else "n/a" end) turns=\($r.num_turns // "n/a")",
          ($r.result // ""),
          $sep,
          $body' "$EXECUTION_FILE"); then
  # The split below keys on the token, not on line position, so a single line works.
  out="(could not read $EXECUTION_FILE — jq's own error is above) $token (transcript unavailable)"
fi
# The verdict line is the whole point of the step, so print it whole. Only the
# transcript body below it is capped, and `tail -c` keeps the END of a run — where a
# review that stopped early stopped.
# Split on the token alone, never on a pattern containing a newline.
printf '%s\n' "${out%%"$token"*}"
echo "--- last assistant message (final 60000 bytes) ---"
printf '%s\n' "${out#*"$token"}" | tail -c 60000
