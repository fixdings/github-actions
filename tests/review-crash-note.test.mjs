// `crash_note` in the review workflow's verify step — the shell function that names the crash
// behind a failed review round. Until this file, nothing exercised it: tests/workflows.test.mjs
// `bash -n`s every `run:` block, which proves the block PARSES and nothing about what it answers.
// That is the same gap the peer guard had before #82, and the repo's own rule about it is that a
// guard nothing drives is indistinguishable from one that works.
//
// Two of its guards are invisible to a syntax check and silent when broken, which is what makes a
// behavioural test the only thing that can hold them:
//   · drop `select(. != "")` and an empty subtype prints "(result: )", naming nothing
//   · drop `type == "object"` and a transcript holding a bare JSON string makes jq exit 5, which
//     `|| return 0` swallows into silence — in exactly the partially-written-transcript shape the
//     diagnostic exists for
//
// The third thing pinned here is REACHABILITY, and it is the expensive lesson of this function's
// history: two earlier versions (597ca58, f8c77bb) called it from branches that only run when
// claude-code-action judged the review successful, where `is_error` is false by construction — so
// it printed in no reachable state, and every fixture-level test would still have passed. See the
// upstream evidence in the workflow comment itself.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, REPO_DIR } from "./helpers.mjs";

console.log();
console.log("review workflow: crash_note");

const WORKFLOW = join(REPO_DIR, ".github/workflows/reusable-claude-code-review.yml");
const source = readFileSync(WORKFLOW, "utf8");

// Lift the function out of the YAML block scalar: from `crash_note() {` to the first line whose
// closing brace sits at the same indent. Dedented, it is a standalone bash function — which is the
// point of extracting rather than re-typing it: a test with its own copy pins the copy.
function extractFunction(name) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith(`${name}() {`));
  assert.notEqual(start, -1, `${name}() must exist in ${WORKFLOW}`);
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  assert.notEqual(end, -1, `${name}() must be closed by a brace at its own indent`);
  return lines
    .slice(start, end + 1)
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
    .join("\n");
}

const CRASH_NOTE = extractFunction("crash_note");
const DIR = mkdtempSync(join(tmpdir(), "crash-note-"));

const fixture = (name, body) => {
  const p = join(DIR, name);
  writeFileSync(p, body);
  return p;
};

/** Run the real function with EXECUTION_FILE set, exactly as the step calls it. */
function run(executionFile) {
  const script = `${CRASH_NOTE}\nprintf 'NOTE[%s]' "$(crash_note)"\n`;
  return execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    env: { ...process.env, EXECUTION_FILE: executionFile ?? "" },
    encoding: "utf8",
  });
}

const note = (out) => out.replace(/^NOTE\[|\]$/g, "");

// The cases that must SPEAK. Every one is a shape claude-code-action can actually write: the
// subtypes are its own, and `is_error: true` is the predicate the function tests.
const SPEAKS = [
  ["a JSONL transcript ending in a crash", "crash.jsonl",
    '{"type":"assistant"}\n{"type":"result","subtype":"error_max_turns","is_error":true}\n', "error_max_turns"],
  ["a JSON array transcript", "array.json",
    '[{"type":"result","subtype":"error_during_execution","is_error":true}]\n', "error_during_execution"],
  ["a crash with no subtype at all", "nosub.jsonl",
    '{"type":"result","is_error":true}\n', "error"],
  // `//` substitutes only on null/false, so without the select this prints "(result: )".
  ["a crash whose subtype is the empty string", "empty-sub.jsonl",
    '{"type":"result","subtype":"","is_error":true}\n', "error"],
  ["a crash whose subtype is null", "null-sub.jsonl",
    '{"type":"result","subtype":null,"is_error":true}\n', "error"],
  // Without `type == "object"` jq exits 5 here and the note goes silent — the partially written
  // transcript is precisely when this fires.
  ["a transcript holding a bare JSON string", "mixed.jsonl",
    '{"type":"assistant"}\n"a bare string"\n{"type":"result","subtype":"error_during_execution","is_error":true}\n',
    "error_during_execution"],
  // `last`, not `first`: a transcript may hold more than one result and the final one is the verdict.
  ["the LAST result record, not the first", "two-results.jsonl",
    '{"type":"result","subtype":"success","is_error":false}\n{"type":"result","subtype":"error_max_turns","is_error":true}\n',
    "error_max_turns"],
];

for (const [what, file, body, want] of SPEAKS) {
  test(`names the crash for ${what}`, () => {
    const out = note(run(fixture(file, body)));
    assert.match(out, /The transcript says the run CRASHED/, `should speak for ${file}`);
    assert.match(out, new RegExp(`\\(result: ${want}\\)`), `should name ${want} for ${file}`);
  });
}

// The cases that must stay SILENT. Silence is the designed answer, not a fallback: an absent or
// unreadable transcript is the normal shape of a failed round (8 of 9 failures in the fortnight to
// 2026-09-08 wrote none), and the step reports on the review rather than failing over its own
// diagnostics.
const SILENT = [
  ["the action judged the run successful", "ok.jsonl", '{"type":"result","subtype":"success","is_error":false}\n'],
  ["there is no result record", "noresult.jsonl", '{"type":"assistant"}\n'],
  ["the transcript is not JSON", "garbage.txt", "not json at all\n"],
  ["the transcript is empty", "empty.jsonl", ""],
];

for (const [what, file, body] of SILENT) {
  test(`says nothing when ${what}`, () => {
    assert.equal(note(run(fixture(file, body))), "", `should be silent for ${file}`);
  });
}

test("says nothing when the transcript path is missing or unset", () => {
  assert.equal(note(run(join(DIR, "does-not-exist.jsonl"))), "");
  assert.equal(note(run("")), "");
});

// A workflow command emitted from inside an annotation is the file's own threat model — the
// transcript is the one input here that quotes the PR diff. The subtype is an SDK enum today, so
// this pins the defence rather than a live exposure.
test("a subtype carrying a newline or :: cannot emit a workflow command", () => {
  const out = note(run(fixture("hostile.jsonl",
    '{"type":"result","subtype":"x\\n::set-output name=a::b","is_error":true}\n')));
  assert.match(out, /The transcript says the run CRASHED/);
  assert.equal(out.includes("\n"), false, "no newline may survive into the annotation");
  assert.equal(out.includes("::"), false, "no :: may survive into the annotation");
});

test("the function never exits non-zero, whatever it is handed", () => {
  // Every path returns 0 so the function is safe in `note=$(crash_note)` position, where `bash -e`
  // WOULD see the status. A fixture-free claim would be untestable; this drives the real thing.
  for (const f of ["crash.jsonl", "garbage.txt", "empty.jsonl", "does-not-exist.jsonl"]) {
    const script = `${CRASH_NOTE}\nnote=$(crash_note)\nprintf 'ok'\n`;
    const out = execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: { ...process.env, EXECUTION_FILE: join(DIR, f) },
      encoding: "utf8",
    });
    assert.equal(out, "ok", `assignment position must survive ${f}`);
  }
});

// REACHABILITY. The one thing fixtures cannot see, and the defect that shipped twice: a call from
// any branch below the `REVIEW_OUTCOME = failure` test is dead code, because claude-code-action
// throws on `is_error: true` (run-claude-sdk.ts) and therefore fails the step, so every later
// branch runs only when the record says `is_error: false`.
test("crash_note is called from the review-failure branch and nowhere else", () => {
  const lines = source.split("\n");
  // Comment lines are excluded, and deliberately: the rationale above the function quotes
  // `note=$(crash_note)` to name the position whose exit status matters. Counting prose as a call
  // site is how this assertion first failed.
  const isCall = (l) => l.includes("$(crash_note)") && !l.trim().startsWith("#");
  const calls = lines.filter(isCall);
  assert.equal(calls.length, 1, "exactly one call site — a second one is unreachable by definition");
  const callLine = lines.findIndex(isCall);
  const failureTest = lines.findIndex((l) => l.includes('[ "$REVIEW_OUTCOME" = "failure" ]'));
  assert.notEqual(failureTest, -1, "the REVIEW_OUTCOME failure test must exist");
  assert.ok(
    callLine > failureTest && callLine < failureTest + 4,
    "the call must sit inside the REVIEW_OUTCOME failure branch — anywhere later is a state where " +
      "the action judged the review successful, so is_error is false and the note can never print",
  );
});
