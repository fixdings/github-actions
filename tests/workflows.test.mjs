// The reusable workflows: what every caller runs. The callers themselves (trigger, `run-name`,
// `concurrency`, `permissions`) are fixdings/claude-setup's `claude/integrations/github/` and are
// tested there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR, crossRepo, shorthandAfterGlob, specWorkflowFile, test } from "./helpers.mjs";

console.log();
console.log("Claude GitHub workflows");

// The two that run claude-code-action with an allowlist; the gate and the fixer are below.
const WORKFLOWS = [
  ".github/workflows/reusable-claude.yml",
  ".github/workflows/reusable-claude-code-review.yml",
];

const readWorkflow = (rel) => readFileSync(join(REPO_DIR, rel), "utf8");
// Trim HERE, once, rather than at each call site. Every check below anchors on `^Bash\(`, so
// a single space after a comma in the YAML turns each rule into " Bash(...)" and every one of
// those anchors silently stops matching — the interpreter ban then goes green on `Bash(node:*)`
// itself. Verified: reformatting the list with ", " separators and adding that rule left the
// suite at 83 passed / 0 failed before this trim.
const allowedTools = (src) => {
  const m = src.match(/--allowedTools "([^"]*)"/);
  assert.ok(m, "no --allowedTools in the workflow");
  return m[1].split(",").map((r) => r.trim()).filter(Boolean);
};

const TAG_WORKFLOW = ".github/workflows/reusable-claude.yml";
// The `prompt:` literal block ONLY. Scoping matters: the sensitive-path list also appears in
// the warning step's `sensitive=` line, so an assertion run over the whole file is satisfied by
// the shell step and would pass with the prompt gutted. Caught by review on #101 — the original
// mutation test used a global substitution, which changed both copies of each literal and so
// failed for the wrong reason.
const promptBlock = (src) => {
  const m = src.match(/^ {10}prompt: \|\n((?: {12}.*\n| *\n)*)/m);
  assert.ok(m, "no prompt: block in the workflow");
  return m[1];
};
// The group is a folded scalar, so where its clauses sit on the line is not the invariant.
const collapsed = (block) => block.replace(/\s+/g, " ");

// Typing "@claude" in a comment is meant to be the ONLY way in. The caller's triggers are
// pinned in claude-setup; the job `if` that admits a comment lives here.
test("the Claude tag workflow runs only for a comment that says @claude", () => {
  const src = readWorkflow(TAG_WORKFLOW);
  // Both caller events carry the text at the same path, so one check covers both.
  const gate = collapsed(src.match(/^ {4}if: \|\n(?: {6}.*\n)*/m)?.[0] ?? "");
  assert.match(gate, /contains\(github\.event\.comment\.body, '@claude'\)/, "no @claude gate");
  // The action posts as claude[bot], so without this it re-fires on its own output.
  assert.match(gate, /github\.actor != 'claude\[bot\]'/, "no self-trigger guard");
  // Dead config that still claims a behaviour the triggers no longer support.
  assert.doesNotMatch(src, /label_trigger:/, "label_trigger outlived the label triggers");
});

// A called workflow takes no trigger but `workflow_call`, and a workflow-level `concurrency`
// here is evaluated in the CALLER's context, so it would share the caller's group and wait on
// the caller's own run. The caller owns both.
const REUSABLE_DIR = ".github/workflows/";
const REUSABLE = readdirSync(join(REPO_DIR, REUSABLE_DIR)).filter((n) => /^reusable-.*\.ya?ml$/.test(n));
test("every reusable workflow is workflow_call only, with no concurrency of its own", () => {
  assert.equal(REUSABLE.length, 4, `expected the four reusable workflows, found ${REUSABLE}`);
  for (const f of REUSABLE) {
    const src = readWorkflow(REUSABLE_DIR + f);
    const on = src.match(/^on:\n(?: .*\n|\n)*/m);
    assert.ok(on, `${f}: no trigger block`);
    assert.deepEqual([...on[0].matchAll(/^ {2}(\w+):$/gm)].map((m) => m[1]), ["workflow_call"], `${f}: unexpected triggers`);
    assert.doesNotMatch(src, /^concurrency:/m, `${f}: concurrency belongs to the caller`);
    assert.doesNotMatch(src, /^run-name:/m, `${f}: run-name belongs to the caller`);
    assert.doesNotMatch(src, /\$\{\{\s*vars\./, `${f}: read a caller variable through an input, not vars`);
  }
});

// A step is its `- name:` line, its body, and the comment lines at the step's own indent
// directly above it.
const stepBlocks = (src) => src.match(/^(?: {6}#.*\n)*^ {6}- name: .*\n(?:(?! {6}- name: | {6}#).*\n)*/gm) ?? [];
const stepWithId = (src, id) => stepBlocks(src).find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));

// A `run:` block is shell, and nothing in YAML or in the review flow ever parses it — a broken
// one surfaces as a red job on some future PR, not here. It bites for real: the verify step
// embeds a jq program as ONE single-quoted word, and a single apostrophe in a jq comment inside
// it ("this run's comments") ends that word mid-filter. `bash -n` on the dedented block catches
// exactly that (`unexpected EOF while looking for matching ')'`), and it costs one spawn.
// Dedent to column 0 first: a `run: |` body is indented, and leading whitespace is the one thing
// a shell does not care about, so the block is valid shell either way — but a heredoc terminator
// is NOT, which is why the indentation has to come off rather than being left for bash to judge.
const RUN_BLOCK_INDENT = 10; // `        run: |` sits at 8, so its body starts at 10.
const runBlocks = (src) => {
  const out = [];
  let cur = null;
  for (const line of src.split("\n")) {
    if (/^\s*run: \|\s*$/.test(line)) {
      cur = [];
      out.push(cur);
    } else if (cur) {
      if (line.trim() === "") cur.push("");
      else if (line.startsWith(" ".repeat(RUN_BLOCK_INDENT))) cur.push(line.slice(RUN_BLOCK_INDENT));
      else cur = null; // dedent ends the block
    }
  }
  return out.map((b) => b.join("\n") + "\n");
};

// GitHub parses `${{` ANYWHERE in a value — a shell comment inside `run:` included — and one it
// cannot parse rejects the whole file, so the workflow never runs at all ("workflow file issue").
// `bash -n` above cannot see it: to bash it is a comment. A comment quoting an empty `${{ }}`
// kept claude-review-fix.yml dead from the day it merged (issue #471's live walk). Every file in
// the directory, not WORKFLOWS: that list leaves out the gate and the fixer. Empty only — an
// expression may legitimately span lines inside a folded scalar (claude.yml's concurrency group).
test("no workflow holds an empty expression, which GitHub rejects", () => {
  let files = 0;
  for (const f of readdirSync(join(REPO_DIR, REUSABLE_DIR)).filter((n) => /\.ya?ml$/.test(n))) {
    for (const [i, line] of readWorkflow(REUSABLE_DIR + f).split("\n").entries()) {
      assert.doesNotMatch(line, /\$\{\{\s*\}\}/, `${REUSABLE_DIR}${f}:${i + 1}: an empty expression — GitHub rejects the whole file:\n    ${line.trim()}`);
    }
    files++;
  }
  assert.ok(files >= 4, `expected the workflow files, found ${files}`);
});

test("every workflow `run:` block is valid shell", () => {
  let checked = 0;
  for (const wf of WORKFLOWS) {
    for (const [i, block] of runBlocks(readWorkflow(wf)).entries()) {
      const r = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
      assert.equal(r.status, 0, `${wf}: run block #${i + 1} is not valid shell\n${r.stderr}`);
      checked++;
    }
  }
  // Or a change to the `run: |` spelling silently reduces this to a test of nothing.
  assert.ok(checked >= 2, `expected at least 2 run blocks across the workflows, found ${checked}`);
});

// `use_sticky_comment` delivers every round through ONE comment, so each round overwrites the
// last and only the final review is readable afterwards — measured on #56/#57, 10 of 12 reviews
// were unrecoverable from the API (issue #70). Its default is false and `track_progress` opens a
// tracking comment per run either way, so the record costs nothing but comment volume. A commit
// that copies one workflow over another is how it came in; this is what stops it coming back.
// `track_progress` is the other half of the same invariant, so it is pinned in the same test:
// with sticky gone it is the ONLY thing that opens a per-run comment, and *Verify the review
// actually completed* hard-fails when it finds no checklist. Drop it and every round reports
// UNREVIEWED, which sends the caller into a re-run loop that can never clear.
test("no Claude workflow turns on the sticky comment, and all keep track_progress", () => {
  for (const wf of WORKFLOWS) {
    const src = readWorkflow(wf);
    assert.doesNotMatch(
      src,
      /^\s*use_sticky_comment:/m,
      `${wf}: a sticky comment erases every review round but the last`,
    );
    assert.match(
      src,
      /^\s*track_progress: true$/m,
      `${wf}: without track_progress a round leaves no comment to read back`,
    );
  }
});

// The workflow allowlists are the other place rules are hand-typed, so they get the same
// shape check. Nothing there has an interior `*` today; this keeps it that way.
test("no Claude workflow allowlist pins a `:*` tail after an earlier `*`", () => {
  for (const wf of WORKFLOWS) {
    for (const rule of allowedTools(readWorkflow(wf))) {
      assert.ok(!shorthandAfterGlob(rule), `${wf}: ${rule} matches no command`);
    }
  }
});

// An ALLOWLIST, after the blocklist version was under-inclusive three times: it missed every
// space-form rule, then the no-space spelling (`Bash(node*)`, which grants `node -e` and takes
// `nodemon` with it), then every runner that is not npm or yarn — `pnpm`, `bun`, `deno`, `tsx`,
// `uv`. Each round added names to a list of things to fear, which is an enumeration with no
// end; the set of programs we intend to grant is small, known, and changes about once a year.
//
// So: a wildcard rule must name a command from this set, or the test fails and a human decides.
// A new runner now fails CLOSED. Adding a name here is the deliberate act it should be.
const REVIEWED_SAFE = new Set(["gh", "git", "cat", "diff", "grep", "ls", "printf", "wc", "npm", "yarn"]);

// A rule with no `*` matches exactly one command string and cannot become a shell, so
// `Bash(node tests/all.mjs)` is fine however much it looks like an interpreter grant. Keeping
// that in the predicate, not in the caller's filter, is what lets the name be read literally.
// Bash rules only. A tool grant (`Read`, `mcp__github_ci__*`) names no program and is governed
// by the token and the MCP server, not by this list — folding them in made the check fail on
// `mcp__github_ci__*` with an empty command word.
const commandWord = (rule) => rule.match(/^Bash\(([^\s:)*]+)/)?.[1] ?? "";
const grantsUnreviewedProgram = (rule) =>
  rule.startsWith("Bash(") && rule.includes("*") && !REVIEWED_SAFE.has(commandWord(rule));

// Being on REVIEWED_SAFE is not enough for a program that dispatches to a subcommand: there,
// a `*` standing in for the subcommand also stands in for every option BEFORE it. The docs'
// own example is `Bash(git * main)` — the `*` admits `-c`, "which makes git run a program you
// name" — and `Bash(gh *)` reaches `gh api`, which mutates with no `-X` to match on and so
// walks past the gh-api guard entirely. Both passed the allowlist, since their command word
// is reviewed; what they lack is a subcommand in the literal prefix.
//
// Not every reviewed program needs this: `cat`, `ls`, `grep`, `printf`, `wc` and `diff` take
// no subcommand, so `Bash(cat:*)` is the whole grant and pinning more would be nonsense.
const DISPATCHERS = new Set(["git", "gh", "npm", "yarn"]);
const literalPrefix = (rule) => rule.replace(/^Bash\(/, "").split("*")[0];
const wildcardBeforeSubcommand = (rule) =>
  rule.startsWith("Bash(") &&
  rule.includes("*") &&
  DISPATCHERS.has(commandWord(rule)) &&
  // `:` is the space-form delimiter, so `Bash(git diff:*)` has the prefix "git diff:".
  literalPrefix(rule).trimEnd().replace(/:$/, "") === commandWord(rule);

// The single exemption to the interpreter ban: a rule whose literal prefix — the only part of
// a rule that constrains anything — is exactly this directory.
const PATH_PINNED = "node tests/";
const pathPinned = (rule) => rule.replace(/^Bash\(/, "").split("*")[0] === PATH_PINNED;

// The check is only as good as its list, and the workflows grant too few shapes to exercise
// it. Feed it the spellings directly. The interpreters below were uncaught across review
// rounds 4 and 5 under the blocklist; the runners are what finally made the allowlist the
// right shape, since the point is that NOTHING unlisted gets through, not that these
// particular names are feared.
test("only a reviewed command may carry a wildcard", () => {
  for (const rule of [
    "Bash(node:*)",
    "Bash(node *)",
    "Bash(node*)", // no space: also matches `nodemon`, and grants `node -e`
    "Bash(sh*)",
    "Bash(python3*)",
    "Bash(bash -c*)",
    "Bash(find:*)",
    "Bash(xargs *)",
    "Bash(pnpm *)", // the runners a blocklist of npm|yarn never saw
    "Bash(bun run*)",
    "Bash(deno run*)",
    "Bash(tsx *)",
    "Bash(uv run*)",
    "Bash(nodemon:*)", // not `node`, still an arbitrary program
  ]) {
    assert.ok(grantsUnreviewedProgram(rule), `${rule} runs an unreviewed program but is not flagged`);
  }
  for (const rule of [
    "Bash(npm test*)", // bounded by its literal prefix — checked separately below
    "Bash(git diff:*)",
    "Bash(gh pr view:*)",
    "Bash(node tests/all.mjs)", // no wildcard at all
  ]) {
    assert.ok(!grantsUnreviewedProgram(rule), `${rule} is a reviewed grant, but is flagged`);
  }
});

// A reviewed program is not automatically a bounded grant. These all passed the allowlist —
// their command word is on it — and reach every subcommand of a dispatcher anyway.
test("a wildcard may not stand in for a dispatcher's subcommand", () => {
  for (const rule of [
    "Bash(git *)",
    "Bash(git * main)", // the docs' own example: the `*` admits `-c <prog>`
    "Bash(git:*)",
    "Bash(gh *)", // reaches `gh api`, which mutates with no `-X` to match on
    "Bash(gh:*)",
    "Bash(npm *)",
    "Bash(yarn *)",
  ]) {
    assert.ok(wildcardBeforeSubcommand(rule), `${rule} reaches every subcommand but is not flagged`);
  }
  for (const rule of [
    "Bash(git diff:*)", // subcommand pinned in the literal prefix
    "Bash(gh pr view:*)",
    "Bash(npm test*)",
    "Bash(cat:*)", // takes no subcommand — the grant is the whole command
    "Bash(ls:*)",
    "Bash(grep:*)",
    "Bash(node tests/*)", // not a dispatcher; governed by pathPinned
  ]) {
    assert.ok(!wildcardBeforeSubcommand(rule), `${rule} pins its subcommand, but is flagged`);
  }
});

// Every check in this file anchors on `^Bash\(`, so whitespace in the parsed list is not a
// cosmetic detail — it decides whether the checks run at all. Pin the parser, not just its
// callers, because a formatting change to the YAML is exactly what would slip past review.
test("allowedTools yields bare rules, whatever spacing the YAML uses", () => {
  const spaced = 'x --allowedTools "Bash(node:*), Bash(gh pr view:*) ,Bash(ls:*)" y';
  assert.deepEqual(allowedTools(spaced), ["Bash(node:*)", "Bash(gh pr view:*)", "Bash(ls:*)"]);
  // Untrimmed, this one would read as " Bash(node:*)" and every `^Bash\(` check would miss it.
  assert.ok(allowedTools(spaced).every((r) => r === r.trim() && r.startsWith("Bash(")));
});

// An exemption nobody probes is how a ban rots into a formality, so pin its edges directly
// rather than only through whatever the workflows happen to grant today.
test("the interpreter-ban exemption admits tests/ and nothing else", () => {
  for (const rule of ["Bash(node tests/*)", "Bash(node tests/**/*.*js)"]) {
    assert.ok(pathPinned(rule), `${rule} should be exempt — its literal prefix is "${PATH_PINNED}"`);
  }
  for (const rule of [
    "Bash(node src/*)", // a different directory is a different grant
    "Bash(node *)", // any file anywhere
    "Bash(node:*)", // permits `node -e`
    "Bash(node tests*)", // no slash: also matches `node testsfoo`
    "Bash(node test/*)", // singular, not this repo's directory
    "Bash(find:*)", // the historical regression
    "Bash(bash -c*)",
  ]) {
    assert.ok(!pathPinned(rule), `${rule} must NOT be exempt from the interpreter ban`);
  }
});

// A CI job holding the repo and a token is only as narrow as its narrowest rule. Every
// entry here was in one of these files at some point: `Bash(gh api:*)` is an arbitrary
// write (`gh api -X DELETE .../git/refs/heads/main` matches, and `*` cannot exclude `-X`),
// and `Bash(find:*)` is an arbitrary shell (`find . -exec sh -c`). Both arrived by a
// widening commit that copied one allowlist over another, which is exactly the drift a
// test catches and a review round may not.
//
// NOTE the name: this proves no rule is an UNBOUNDED shell, not that nothing can execute.
// A rule with no `*` matches one command string and cannot become `node -e`, which is why
// rules without a wildcard are skipped below.
// `Bash(npm test*)` runs whatever `scripts.test` says in the PR's own package.json and is
// deliberately allowed (see the review workflow) — what bounds it is the job's trigger, not
// this list: a fork PR gets no secrets, so the action never starts. Read that as an accepted
// exception, not as something the regexes below catch.
test("no Claude workflow grants a wildcard rule for an unreviewed program", () => {
  // ONE exemption, and it is a directory, not a shape. Only the text before a rule's first
  // `*` constrains anything (see the `*`-is-a-trap bullet in CLAUDE.md), so that prefix IS the
  // boundary — which is why the check below compares it literally instead of pattern-matching
  // the operand. `Bash(node tests/*)` is bounded by `node tests/`; `Bash(node tests/**/*.*js)`
  // has the SAME prefix and is therefore the same grant wearing a costume, and `Bash(node
  // src/*)` is a different grant and stays banned.
  //
  // What the exemption buys: the reviewer can run one topic file (`node tests/rm-guard.test.mjs`)
  // instead of only the whole suite. What it costs, stated plainly: any file a PR places under
  // tests/ becomes runnable, and `node tests/../../x.js` starts with the prefix too. Neither is
  // new exposure — `Bash(npm test*)` already runs whatever the PR's own `scripts.test` says —
  // but this is the second grant with that property, not a free one.
  //
  // A flag before the path does NOT get in: `node -r ./evil.cjs tests/all.mjs` does not start
  // with `node tests/`, which is what separates this from `Bash(node *)`.
  for (const wf of WORKFLOWS) {
    // A rule with no `*` matches exactly one command string and cannot be turned into a
    // shell, which is why `Bash(node tests/all.mjs)` is fine and `Bash(node:*)` is not.
    for (const rule of allowedTools(readWorkflow(wf)).filter((r) => r.includes("*"))) {
      if (pathPinned(rule)) continue;
      assert.ok(
        !grantsUnreviewedProgram(rule),
        `${wf} grants ${rule} — "${commandWord(rule)}" is not in REVIEWED_SAFE, so this rule can run ` +
          "an unreviewed program. Add it there deliberately, or narrow the rule.",
      );
      assert.ok(
        !wildcardBeforeSubcommand(rule),
        `${wf} grants ${rule} — its \`*\` stands in for "${commandWord(rule)}"'s subcommand AND the ` +
          "options before it, so it reaches every subcommand (and `git -c <prog>` / `gh api`). " +
          "Pin the subcommand in the literal prefix.",
      );
    }
  }
  // The script-runner grants exist so a reviewer can actually run the suite it is reviewing.
  // They are bounded by their literal prefix and nothing else, so the prefix must still pin a
  // test script: `Bash(npm test*)` runs `scripts.test`, but `Bash(npm *test*)` has the prefix
  // `npm ` and would match `npm run deploy --flag=test` — the tail after a `*` is satisfiable
  // by an argument. Same trap as the `gh api` rule below, in script-runner form.
  for (const wf of WORKFLOWS) {
    for (const rule of allowedTools(readWorkflow(wf)).filter((r) => /^Bash\((npm|yarn)\b/.test(r))) {
      const literal = rule.replace(/^Bash\(/, "").split("*")[0];
      assert.ok(
        /^(npm|yarn)( run)? test/.test(literal),
        `${wf} grants ${rule} — its literal prefix "${literal}" does not pin a test script`,
      );
    }
  }
  // `Bash(gh api:*)` is an arbitrary write via the API, whatever else the rule pins.
  for (const wf of WORKFLOWS) {
    for (const rule of allowedTools(readWorkflow(wf))) {
      assert.ok(!/^Bash\(gh api\b/.test(rule), `${wf} grants ${rule} — an arbitrary write via the API`);
    }
  }
});

// claude-code-action does NOT use github.token: it exchanges the OIDC token for a Claude
// App token whose scopes are DEFAULT_PERMISSIONS (contents/issues/pull_requests: write)
// merged with `additional_permissions` (src/github/token.ts). So the job's `permissions:`
// block cannot hold a reviewer to read-only — only a `contents: read` line here can, and
// without it the allowlist is the sole thing between an injected instruction in the diff
// and a commit. `actions: read` must survive alongside it or mcp__github_ci__* goes away.
test("the review workflow mints Claude's token without contents: write", () => {
  const src = readWorkflow(".github/workflows/reusable-claude-code-review.yml");
  // [\w-]+ because the action accepts hyphenated keys (`pull-requests: read`), and the
  // value is cut at a trailing `#` so an inline comment does not end up in it.
  const m = src.match(/additional_permissions: \|\n((?:\s+[\w-]+:[^\n]*\n)+)/);
  assert.ok(m, "no additional_permissions block in the review workflow");
  const perms = Object.fromEntries(
    m[1]
      .trim()
      .split("\n")
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).replace(/#.*$/, "").trim()];
      }),
  );
  assert.equal(perms.contents, "read", "the reviewer would hold contents: write");
  assert.equal(perms.actions, "read", "dropping this loses mcp__github_ci__*");
});

// The allowlist is a ceiling, and a tool the prompt asks for but cannot get is not an error:
// headless denies it and the reviewer silently skips that ground. These are the calls the five
// review dimensions in the prompt name — gh pr list / gh pr view / gh search for comments on
// earlier PRs touching these files, git blame for history — so losing one degrades the review
// without failing the job. (They were first written down for the `code-review` plugin, whose
// frontmatter declared the same set; the plugin is gone and the requirement outlived it.)
// The reviewer REPORTS: it must hold no tool that writes. Two of those absences are asserted
// by the prompt itself — "no inline-comment tool is granted at all", and the rule against a
// second comment — so a re-grant makes the prompt lie while every other test stays green. The
// hazard is concrete: these two workflows are maintained as a hand-copied pair, and claude.yml's
// list BEGINS with the inline-comment tool, which is one careless paste away.
test("the reviewer holds no tool that writes to the PR", () => {
  const rules = allowedTools(readWorkflow(".github/workflows/reusable-claude-code-review.yml"));
  for (const banned of [
    "mcp__github_inline_comment__create_inline_comment", // committable suggestions: claude.yml only
    "Bash(gh pr comment:*)",                             // a second comment the verify step cannot see
  ]) {
    assert.ok(!rules.includes(banned),
      `the review prompt promises ${banned} is not granted, but the allowlist grants it`);
  }
  // The other half of the pair keeps it, deliberately — that is where a blocked edit goes back.
  const tag = allowedTools(readWorkflow(".github/workflows/reusable-claude.yml"));
  assert.ok(tag.includes("mcp__github_inline_comment__create_inline_comment"),
    "claude.yml must keep the inline-comment tool: its prompt tells it to post suggestions");
});

test("the review allowlist covers the tools the review dimensions reach for", () => {
  const rules = allowedTools(readWorkflow(".github/workflows/reusable-claude-code-review.yml"));
  for (const needed of [
    "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh pr list:*)",
    "Bash(gh issue view:*)", "Bash(gh issue list:*)", "Bash(gh search:*)", "Bash(git blame:*)",
  ]) {
    assert.ok(rules.includes(needed), `the review prompt asks for ${needed}, but it is not allowed`);
  }
});

// `claude-code-action` deletes .claude/, CLAUDE.md and six other config paths from the PR head
// and restores the BASE branch's versions before Claude starts (restoreConfigFromBase — the PR
// head can instruct the reviewer, so it is untrusted). There is no opt-out input. The reviewer
// therefore reads a tree that is partly base: a path the PR ADDED is absent, one it CHANGED
// reads as the old version. On PR #97 that erased 100% of one round's delta — the round's head
// touched only `.claude/specs/**` — and the reviewer, seeing no change, reported the fix as not
// applied. It also failed a test that reads those files, which two agents spent a round chasing.
//
// The action already preserves the truth at `.claude-pr/<path>`; nothing was telling the
// reviewer it existed. That is what these assertions pin. Issue #98 has the run logs.
//
// THE LIMIT OF THIS TEST, stated because it is easy to over-read: it checks the instruction is
// PRESENT, never that it is TRUE. If the action renames `.claude-pr/` or changes which paths it
// restores, this stays green while the reviewer is misled exactly as before. Re-verify against
// the action's `restore-config.ts` when bumping it, not against this test.
// `SENSITIVE_PATHS` in the action's src/github/operations/restore-config.ts, read at main on
// 2026-09-10 and byte-checked against it. One list, shared by both tests below — two hand-kept
// copies is how the prompt and the warning step drift apart, which is the bug the second test
// exists to catch and originally could not.
const RESTORED_PATHS = [".claude", ".mcp.json", ".claude.json", ".gitmodules", ".ripgreprc",
                        "CLAUDE.md", "CLAUDE.local.md", ".husky"];

test("the review prompt tells the reviewer the config paths it sees are the base branch's", () => {
  const src = promptBlock(readWorkflow(".github/workflows/reusable-claude-code-review.yml"));
  assert.ok(
    src.includes(".claude-pr/"),
    "the prompt must name .claude-pr/ — it is where the action preserves the PR's real versions",
  );
  // The list is the reviewer's map of what not to trust; a path missing here is one it will
  // judge from a base-branch file believing it is the PR's.
  for (const p of RESTORED_PATHS) {
    // The prompt writes the directory with its trailing slash; the shell list matches on the
    // bare name plus a separator, so the two spellings differ for exactly this one entry.
    const spelled = p === ".claude" ? ".claude/" : p;
    assert.ok(src.includes(spelled), `the restored path ${spelled} is not named in the prompt`);
  }
  // `.claude-pr/` is a dot-directory AND the action adds it to `.git/info/exclude`
  // (`ensureClaudePrExcludedFromGit`). Ripgrep-backed Grep/Glob skip hidden and ignored paths,
  // so a reviewer told only "check .claude-pr/" sweeps it, gets zero hits, and concludes the
  // snapshot does not exist — back at the #98 wrong answer by a new route. Naming a route that
  // actually reads it is the difference between the instruction working and looking like it does.
  assert.match(src, /ls -aR \.claude-pr/,
    "the prompt must name a RECURSIVE route into .claude-pr/ — Grep and Glob skip it entirely, and a plain `ls -a` shows only the top-level entry because the snapshot mirrors nested paths");
  // The restore only snapshots paths that still exist in the head, so a DELETED path has no
  // `.claude-pr/` entry at all and reads as still present. Without this the reviewer either
  // reports the deletion as not applied or reviews the resurrected file.
  assert.match(src, /DELETED/,
    "the prompt covers ADDED and CHANGED but must also cover DELETED, which has no snapshot");
  // Each cause pairs with ONE git status state, and an earlier revision listed the states in a
  // different order from the causes — so a reviewer reading positionally got ADDED->modified and
  // CHANGED->deleted, the opposite of the truth for the two commonest cases. Pin the pairs.
  // Collapse first: the pair can straddle a YAML line wrap ("shows as\n            MODIFIED"),
  // and a literal-space pattern then silently fails on exactly one of the three.
  const flat = collapsed(src);
  for (const [cause, state] of [["ADDED", "DELETED"], ["CHANGED", "MODIFIED"], ["DELETED", "UNTRACKED"]]) {
    assert.match(flat, new RegExp(`${cause}[^.;]*?shows as ${state}`),
      `the prompt must pair ${cause} with git status ${state} in the same clause, not in a separate list`);
  }
});

// The DELETED route needs a base sha, and `git rev-parse`/`git merge-base` are not in
// --allowedTools — so if the prompt does not hand one over, the reviewer reaches the same dead
// end the DELETED guidance exists to remove, one step later.
test("the review prompt supplies the base sha it tells the reviewer to use", () => {
  const src = promptBlock(readWorkflow(".github/workflows/reusable-claude-code-review.yml"));
  assert.match(src, /BASE SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    "the prompt names a base sha route but never supplies the value");
});

// The warning step carries the SAME eight paths in its `sensitive=` shell list, guarded only by
// a "keep in sync" comment while the prompt's copy is pinned above. When the action adds a ninth
// path, the test forces the prompt to be updated and says nothing about the shell list — so the
// warning silently under-reports with nothing red. Derive one from the other instead.
test("the sensitive-path warning step lists exactly the paths the prompt names", () => {
  const src = readWorkflow(".github/workflows/reusable-claude-code-review.yml");
  const m = src.match(/^ +sensitive="([^"]*)"/m);
  assert.ok(m, "no `sensitive=` list in the warning step");
  const shell = m[1].split(/\s+/).filter(Boolean).sort();
  const prompt = promptBlock(src);
  // The prompt writes the directory as `.claude/`; the shell list matches on `.claude` plus a
  // `/` separator, so compare on the bare name.
  // BOTH directions. shell-subset-of-prompt alone passes the very drift this test documents:
  // the action adds a ninth path, the prompt is updated (forced by the test above), the shell
  // list is not, and the warning silently under-reports. Verified — that mutation left the
  // suite green until this half was added.
  const inPrompt = (p) => prompt.includes(p === ".claude" ? ".claude/" : p);
  assert.deepEqual(shell.filter(inPrompt), shell,
    `in the shell list but not named in the prompt: ${shell.filter((p) => !inPrompt(p))}`);
  // PARSE the prompt's own path sentence rather than iterating the known set: filtering
  // RESTORED_PATHS can only ever re-check paths we already listed, so a genuinely NEW ninth
  // path added to the prompt slips through — which is precisely the drift being guarded.
  const sentence = prompt.match(/for these paths:([\s\S]*?) are\n/);
  assert.ok(sentence, "the prompt's path sentence changed shape — this test parses it");
  const promptPaths = [...sentence[1].matchAll(/(?:^|[\s,])(\.?[A-Za-z][\w.-]*)/g)]
    .map((m) => m[1].replace(/\/$/, ""))
    .filter((w) => w !== "and");
  const missingFromShell = promptPaths.filter((p) => !shell.includes(p));
  assert.deepEqual(missingFromShell, [],
    `named in the prompt but missing from the warning step's list: ${missingFromShell}`);
  assert.deepEqual(shell, [...RESTORED_PATHS].sort(),
    "the shell list must be exactly the restored set — re-verify against restore-config.ts");
});

// Two independent things made CI's count differ from a local one on #97, and only one was the
// restore. `tests/scripts-syntax.test.mjs` lints each script under sh, then repeats for dash and
// zsh ONLY where present; ubuntu-latest has dash but no zsh, so exactly 5 assertions skip and
// the suite reports 250 where a local run reports 255. A reviewer comparing the two reads a
// five-test gap as tests that vanished with the diff.
test("the review prompt warns that a CI suite count can be lower than a local one", () => {
  const src = promptBlock(readWorkflow(".github/workflows/reusable-claude-code-review.yml"));
  assert.match(
    src,
    /optional interpreter/,
    "the prompt must explain that interpreter-gated tests skip in CI, or a lower count reads as missing tests",
  );
});

// #609: the reviewer spent a turn on `node --test <file>`, which no rule grants, for a file the
// granted `npm test` already ran. The prompt names the granted runners so it reaches for those.
test("the review prompt names the granted test runners", () => {
  const src = collapsed(promptBlock(readWorkflow(".github/workflows/reusable-claude-code-review.yml")));
  assert.match(src, /Run tests only through the runners your tool list grants/,
    "without it the reviewer tries an ungranted runner and reports the file unrunnable");
  for (const runner of ["`npm test`", "`npm run test…`", "`yarn test`", "`yarn run test…`", "`node tests/<file>`"]) {
    assert.ok(src.includes(runner), `the prompt must name the granted runner ${runner}`);
  }
  assert.match(src, /third-party package it depends on is the runner/,
    "a missing sub-package dependency must not read as the PR's defect");
  assert.match(src, /relative import is still the PR's/,
    "a broken relative import is the PR's defect, not runner noise");
  assert.doesNotMatch(src, /--prefix/, "no runner installs a sub-package's deps, so --prefix fails here");
});

// #607: a tag-mode run retried Edit on `.claude/specs/` after the protected-path refusal. No
// allow rule or hook lifts it (probed on CLI 2.1.301), so the prompt routes it to the hand-back.
test("the tag-mode prompt sends protected-path edits to the hand-back", () => {
  // The system prompt, not the file: a copy in a YAML comment instructs nothing.
  const src = readWorkflow(".github/workflows/reusable-claude.yml").match(/--append-system-prompt "([^"]*)"/)?.[1] ?? "";
  assert.match(src, /PROTECTED PATHS ARE NOT WRITABLE IN THIS RUN/,
    "without it the run burns turns on writes Claude Code always refuses in CI");
  assert.match(src, /except \.claude\/worktrees\/ and Markdown under \.claude\/agent-memory\//,
    "the documented .claude/ exceptions stay writable and must not be handed back");
  for (const p of [".git,", ".husky,", ".npmrc,", ".mcp.json,", "lefthook.yml;"])
    assert.ok(src.includes(` ${p}`), `the inline protected list must keep ${p.slice(0, -1)}, not only .claude/`);
  assert.match(src, /permission-modes#protected-paths/, "the inline list is partial; the docs link covers the rest");
  assert.match(src, /refused as a sensitive file, do not retry it/,
    "the inline list is partial and the run cannot fetch the docs, so a refusal must not be retried");
  assert.match(src, /a protected-path edit outside THIS PR diff \(every one on an issue run\) — goes in your comment as a fenced diff/,
    "an issue run has no diff to anchor a suggestion, so it needs the fenced-diff route");
});

// Checkout defaults to refs/pull/N/merge on a pull_request event — a merge commit whose sha the
// prompt never names. NOT the cause of #98 (base had not moved, so the merge tree equalled the
// head tree), but a real divergence for any PR that has not merged base in.
test("the review workflow checks out the PR head sha, not the merge ref", () => {
  const src = readWorkflow(".github/workflows/reusable-claude-code-review.yml");
  assert.match(src, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
    "without an explicit ref the tree is refs/pull/N/merge, not the reviewed commit");
  assert.match(src, /fetch-depth: 0/,
    "fetch-depth: 0 must stay — a shallow clone has no merge-base and three-dot diffs fail");
});

// `gh api` switches the HTTP method to POST as soon as ANY parameter is added (`-f`/`-F`/`--raw-field`),
// which CLAUDE.md already records for a different reason — it is why `Bash(gh api:*)` is not in `allow`.
// Here it bites as a plain bug: `-F per_page=100` on a GET endpoint POSTs and 404s. It failed run
// 34486242726 on PR #101, where the 404 left the UNREVIEWED-BY-DESIGN branch unable to read the file
// list and the job hard-failed on a PR that was fine. Verified both ways against the live API:
// `…/files?per_page=100` returns the files, `-F per_page=100` returns `{"message": "Not Found"}`.
// Query string only.
test("no gh api call in a workflow adds a parameter, which would flip it to POST", () => {
  // The auto-merge gate too (defined below): its reads are all GETs, and a `-f since=…` there
  // would POST to the comments endpoint and create nothing but a 404 and a gate-error stop.
  for (const wf of [...WORKFLOWS, ".github/workflows/reusable-claude-auto-merge.yml", ".github/workflows/reusable-claude-review-fix.yml"]) {
    for (const line of readWorkflow(wf).split("\n")) {
      if (!line.includes("gh api")) continue;
      assert.doesNotMatch(
        line,
        / -(?:f|F|-field|-raw-field) /,
        `${wf}: this gh api call adds a parameter, so gh sends POST and the endpoint 404s — put it in the query string:\n    ${line.trim()}`,
      );
    }
  }
});

// The completion gate is an awk program embedded in a `run:` block, so nothing parses it and
// nothing exercised it — `bash -n` above proves it is syntax, not that it counts correctly.
// It got this wrong for real (#102): the terminator was "any non-blank, non-checkbox line", so
// ONE line of prose between two items ended the tracker there, every item below went uncounted,
// and an UNFINISHED review passed the round green. These run the shipped program against the
// exact shapes that broke it.
const awkProgram = (src, name) => {
  const m = new RegExp(`${name}=\\$\\(printf '%s\\\\n' "\\$body" \\| awk '\\n([\\s\\S]*?)'\\)`).exec(src);
  assert.ok(m, `could not extract the ${name} awk program — the verify step's spelling changed`);
  return m[1];
};
const runAwk = (prog, input) => {
  const r = spawnSync("awk", [prog], { input, encoding: "utf8" });
  assert.equal(r.status, 0, `awk failed: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
};
const GATE_WF = ".github/workflows/reusable-claude-code-review.yml";
const unchecked = (lines) => lines.filter((l) => /^\s*[-*+] \[ \]/.test(l));

test("the completion gate counts checklist items separated by prose (#102)", () => {
  // The regression itself. Before the fix `block` was one line and `pending` was 0, so this
  // review — two of its four tasks unfinished — was reported as complete.
  const body = ["### Review checklist", "- [x] a", "commentary the model put mid-list", "- [ ] b", "- [ ] c"].join("\n");
  const block = runAwk(awkProgram(readWorkflow(GATE_WF), "block"), body);
  assert.equal(block.length, 3, `all three items must be in the tracker, got:\n${block.join("\n")}`);
  assert.equal(unchecked(block).length, 2, "both unfinished items must be counted, so the round fails");
});

test("a heading ends the tracker, so follow-ups below it never fail a finished review", () => {
  // The other direction, and the reason the terminator is a heading rather than nothing at all:
  // a `Follow-ups:` list in the findings prose must not report a completed review as UNREVIEWED.
  const body = [
    "### Review checklist", "- [x] a", "- [x] b", "", "### Findings", "Some prose.", "Follow-ups:", "- [ ] later thing",
  ].join("\n");
  const src = readWorkflow(GATE_WF);
  const block = runAwk(awkProgram(src, "block"), body);
  assert.equal(block.length, 2, `the tracker stops at the heading, got:\n${block.join("\n")}`);
  assert.equal(unchecked(block).length, 0, "a finished review must not be reported UNREVIEWED");
  // Not silently dropped either — #102 was a silent pass, so what falls outside is warned about.
  const trailing = runAwk(awkProgram(src, "trailing"), body);
  assert.deepEqual(trailing.map((l) => l.trim()), ["- [ ] later thing"]);
});

test("nothing trails a review whose checklist is the only checkbox list", () => {
  // Or the warning fires on every ordinary review and stops meaning anything.
  const body = ["### Review checklist", "- [x] a", "- [x] b", "", "### Findings", "No issues."].join("\n");
  assert.deepEqual(runAwk(awkProgram(readWorkflow(GATE_WF), "trailing"), body), []);
});

test("a # inside a code fence, or a shebang, does not end the tracker", () => {
  // The heading terminator reintroduced #102 through a side door on its first draft: a review
  // quoting a diff writes `# comment` inside a fence and `#!/bin/sh`, and `^[[:space:]]*#`
  // matched both — items below went uncounted again. Caught by probing the shipped program,
  // not by reading it, which is why these fixtures exist rather than a comment.
  const src = readWorkflow(GATE_WF);
  const prog = awkProgram(src, "block");
  const fenced = ["### Review checklist", "- [x] a", "```sh", "# rebuild the thing", "```", "- [ ] b", "- [ ] c"];
  assert.equal(runAwk(prog, fenced.join("\n")).length, 3, "a fenced # comment must not terminate the tracker");
  const shebang = ["### Review checklist", "- [x] a", "#!/bin/sh", "- [ ] b"];
  assert.equal(runAwk(prog, shebang.join("\n")).length, 2, "a shebang is not a heading");
  // And the fence cuts the other way too: a checkbox quoted inside one is not a tracker item.
  const quoted = ["### Review checklist", "- [x] a", "```", "- [ ] not a task", "```", "- [x] b"];
  const block = runAwk(prog, quoted.join("\n"));
  assert.equal(block.length, 2, `a checkbox inside a fence is quoted content, got:\n${block.join("\n")}`);
  assert.equal(unchecked(block).length, 0, "a quoted unchecked box must not fail a finished review");
});

// Spec PRs never converged: every finding was carried forward, a reasoned decline counted for
// nothing, and a rule citation shipped at 75 with no likelihood check. The plugin half of the
// same fix is pinned in plugins.test.mjs.
test("the review prompt requires a scenario and settles a reasoned decline", () => {
  const src = collapsed(promptBlock(readWorkflow(".github/workflows/reusable-claude-code-review.yml")));
  assert.match(src, /EVERY RUNTIME-DEFECT FINDING AT 75\+ NAMES ITS SCENARIO/);
  assert.match(src, /A finding that is wrong ON PAPER needs no scenario/,
    "a spec contradiction has no runtime input; capping it at 25 would let a contradictory spec merge");
  assert.match(src, /declined under `## Review focus` → Skip with a reason that REFUTES ITS SCENARIO .* is ANSWERED/);
  assert.match(src, /a reason that REFUTES ITS SCENARIO/, "a decline answers only by refuting the scenario");
  assert.match(src, /the BODY too, with `gh pr view --json body`/,
    "`## Review focus` is often updated after the push that started the run, so the cached body can predate it");
  assert.match(src, /A reason that only EXCUSES the defect .* answers nothing/,
    "an excuse must not settle a finding the bot reported with a scenario");
  assert.match(src, /A SPEC PR is reviewed as one\. When every changed path is under `\.claude\/specs\/`/,
    "the narrowed scope is for specs only: other markdown can be a prompt, which is behaviour");
  assert.doesNotMatch(src, /A comment made there frequently applies here too/,
    "earlier PRs are for settled points, not a source of findings to re-import");
});

test("the review prompt names decisions.md (35 · Req 4.6)", () => {
  assert.match(collapsed(readWorkflow(GATE_WF)),
    /against a resolved decision in `decisions\.md` \(or `00-overview\.md` where there is none\)/);
});

// #213: the round/triage rules are stated once in the plugin (`watch-pr` § Scoring a round) and
// once more here, because the bot cannot read the plugin. Most findings on #206 were two copies
// saying the same rule slightly differently, so the lists are PARSED from both and compared in
// both directions — a kind added to either side without the other goes red.
crossRepo("the review prompt's round rules agree with watch-pr's Scoring a round", () => {
  const norm = (s) => s.replace(/\*/g, "").replace(/\s+/g, " ").toLowerCase();
  const bot = norm(promptBlock(readWorkflow(".github/workflows/reusable-claude-code-review.yml")));
  const watchSrc = specWorkflowFile("claude/plugins/spec-workflow/skills/watch-pr/SKILL.md");
  const section = watchSrc.split("## Scoring a round")[1]?.split("\n## ")[0];
  assert.ok(section, "watch-pr lost its `## Scoring a round` section — this test parses it");
  const watch = norm(section);

  const kinds = (list) => list.replace(/\s*\([^)]*\)/g, "").split(/,\s*(?:or\s+)?/).map((k) => k.trim()).filter(Boolean).sort();
  const watchList = watch.match(/\(the same list as the review bot's prompt\): (.*?)\.(?: |$)/);
  const botList = bot.match(/a finding that is wrong on paper needs no scenario — (.*?); score it on the evidence/);
  assert.ok(watchList && botList, "the on-paper list changed shape in one copy — this test parses both");
  assert.deepEqual(kinds(botList[1]), kinds(watchList[1]),
    "the bot's on-paper kinds and watch-pr's must be the same list");

  assert.match(watch, /runtime defect with a scenario/);
  assert.match(bot, /runtime-defect finding at 75\+ names its scenario/);
  for (const [name, text] of [["watch-pr", watch], ["the bot", bot]]) {
    assert.match(text, /refutes? (?:the|its) scenario/, `${name}: a decline answers by refuting the scenario`);
    assert.match(text, /quotes? the agreed requirement[^.]*?already on the base branch/,
      `${name}: a quoted requirement answers only when it is already on the base branch`);
    assert.match(text, /rule breach whose only consequence is style/, `${name}: a style-only breach never blocks`);
  }
  const excuses = (text, re) => [...(text.match(re)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const watchExcuses = excuses(watch, /never excuse the defect \(([^)]*)\)/);
  assert.ok(watchExcuses.length > 0, "watch-pr's excuse list changed shape — this test parses it");
  assert.deepEqual(excuses(bot, /a reason that only excuses the defect \(([^)]*)\)/), watchExcuses,
    "an excuse that settles nothing must be the same excuse in both copies");
});

// The merge workflow is not a Claude workflow (no action step, no allowlist), so it stays out of
// WORKFLOWS. It ships as a TEMPLATE only: this repo does not run it — `claude-setup github`
// installs it where auto-merge is turned on. What it must hold: it runs the DEFAULT branch's copy
// (workflow_run), it listens to the review workflow by its exact name and pins its path, and
// its two parsers — the sensitive-path matcher and the verdict counter — answer correctly.
const MERGE_WORKFLOW = ".github/workflows/reusable-claude-auto-merge.yml";
const mergeScript = () => {
  const blocks = runBlocks(readWorkflow(MERGE_WORKFLOW));
  assert.equal(blocks.length, 1, "the merge workflow has one run block");
  return blocks[0];
};
const shellVar = (script, name) => {
  const m = new RegExp(`^${name}='\\n([\\s\\S]*?)'$`, "m").exec(script);
  assert.ok(m, `could not extract ${name} — its spelling in the merge workflow changed`);
  return m[1];
};

test("the merge workflow is valid shell", () => {
  const r = spawnSync("bash", ["-n"], { input: mergeScript(), encoding: "utf8" });
  assert.equal(r.status, 0, `the merge workflow's run block is not valid shell\n${r.stderr}`);
});

// The caller's `on: workflow_run` of the review by name is pinned in claude-setup.
test("the merge workflow pins the review workflow's path and merges only the reviewed commit", () => {
  const src = readWorkflow(MERGE_WORKFLOW);
  assert.match(src, /workflow_run\.path == '\.github\/workflows\/claude-code-review\.yml'/,
    "a name is claimable by any workflow, so the path must be pinned too");
  assert.match(src, /--match-head-commit "\$HEAD_SHA"/, "merge only the reviewed commit");
  assert.doesNotMatch(src, /actions\/checkout/, "never check out PR code in a job holding a write token");
});

test("the merge workflow's sensitive-path matcher", () => {
  const script = mergeScript();
  const prog = shellVar(script, "SENSITIVE_AWK");
  const list = script.match(/REVIEW_SENSITIVE_PATHS:-([^}]*)\}/)[1];
  const hits = (paths, l = list) => {
    const r = spawnSync("awk", ["-v", `list=${l}`, prog], { input: paths.join("\n") + "\n", encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n").filter(Boolean);
  };
  assert.deepEqual(hits([".github/workflows/x.yml", ".claude/rules/a.md", "docs/CLAUDE.md", ".husky/pre-commit",
    ".mcp.json", "CLAUDE.local.md"]), [".github/workflows/x.yml", ".claude/rules/a.md", "docs/CLAUDE.md",
    ".husky/pre-commit", ".mcp.json", "CLAUDE.local.md"]);
  assert.deepEqual(hits([".claude/specs/20/tasks.md", "cli/setup.mjs", "README.md", ".claudeignore", "x/.github"]), [],
    "spec files, ordinary code, and look-alike names are not sensitive");
  assert.deepEqual(hits(["a/b.txt", "a/c.txt", "b.txt"], "a/ !a/c.txt"), ["a/b.txt"], "an exception wins over a match");
  assert.deepEqual(hits(["src/x.js", "x.js"], "src/x.js"), ["src/x.js"], "an entry with a slash is an exact path");
});

test("the merge workflow lists the non-blocking findings to file, outside code fences", () => {
  const prog = shellVar(mergeScript(), "FOLLOWUPS_AWK");
  const list = (body) => {
    const r = spawnSync("awk", [prog], { input: body, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const body = [
    "Round 2 of 5 · VERDICT: CLEAN",
    "- [blocking] (75) fixed earlier — not filed",
    "- [non-blocking] (50) first",
    "  its scenario",
    "  ```suggestion",
    "  x",
    "  ```",
    "- [non-blocking] (60) second\r",
    "prose after the list",
    "  indented prose, not a continuation",
    "```",
    "- [non-blocking] (55) quoted in a fence — not filed",
    "```",
    "VERDICT: CLEAN",
  ].join("\n") + "\n";
  assert.equal(list(body),
    "- [ ] [non-blocking] (50) first\n  its scenario\n  ```suggestion\n  x\n  ```\n- [ ] [non-blocking] (60) second\n");
  assert.equal(list("Round 1 of 5 · VERDICT: CLEAN\n\nVERDICT: CLEAN\n"), "", "no findings, nothing to file");
  // #495 round 1: a blank line inside a bullet's own fence must not end the bullet, or its
  // closing fence opens a top-level one and every later finding is lost.
  assert.equal(list("- [non-blocking] (50) a\n  ```\n  x\n\n  y\n  ```\n- [non-blocking] (60) b\n"),
    "- [ ] [non-blocking] (50) a\n  ```\n  x\n\n  y\n  ```\n- [ ] [non-blocking] (60) b\n");
  // A blank line that ends a bullet is not carried into the list.
  assert.equal(list("- [non-blocking] (50) a\n\n- [non-blocking] (60) b\n\nprose\n"),
    "- [ ] [non-blocking] (50) a\n- [ ] [non-blocking] (60) b\n");
  // #495 review: column-0 code inside a bullet's own fence stays in the bullet, re-indented to
  // the fence, and the closing fence does not open a top-level one.
  assert.equal(list("- [non-blocking] (50) a\n  ```suggestion\nx = 1\n  ```\n- [non-blocking] (60) b\n"),
    "- [ ] [non-blocking] (50) a\n  ```suggestion\n  x = 1\n  ```\n- [ ] [non-blocking] (60) b\n");
  // Any list marker, a bolded tag, and items nested under a group, dedented to the top level;
  // a sibling at the item's own indent ends it.
  assert.equal(list("* **[non-blocking]** (50) a\n  scen\n1. [non-blocking] (55) c\n2) [non-blocking] (56) d\n+ [non-blocking] (57) e\n"),
    "- [ ] **[non-blocking]** (50) a\n  scen\n- [ ] [non-blocking] (55) c\n- [ ] [non-blocking] (56) d\n- [ ] [non-blocking] (57) e\n");
  assert.equal(list("- Non-blocking\n  - [non-blocking] (50) n1\n    detail\n  - [blocking] (75) x\n    not filed\n  - [non-blocking] (51) n2\n"),
    "- [ ] [non-blocking] (50) n1\n  detail\n- [ ] [non-blocking] (51) n2\n");
});

test("the merge workflow reads exactly one verdict, outside code fences", () => {
  const prog = shellVar(mergeScript(), "VERDICT_AWK");
  const verdicts = (lines) => runAwk(prog, lines.join("\n"));
  assert.deepEqual(verdicts(["### Review checklist", "- [x] a", "", "VERDICT: CLEAN"]), ["VERDICT: CLEAN"]);
  assert.deepEqual(verdicts(["VERDICT: BLOCKING 2\r", "VERDICT: CLEAN  "]), ["VERDICT: BLOCKING 2", "VERDICT: CLEAN"],
    "two verdicts are both reported, so the step refuses to pick one");
  assert.deepEqual(verdicts(["```", "VERDICT: CLEAN", "```", "VERDICT: BLOCKING 1"]), ["VERDICT: BLOCKING 1"],
    "a quoted verdict inside a fence is not the verdict");
  assert.deepEqual(verdicts(["VERDICT: BLOCKING 0", "verdict: clean", "> VERDICT: CLEAN", "VERDICT: CLEAN now"]), [],
    "malformed lines are no verdict");
});

// Spec 20 § 1: the review ends in a verdict the auto-merge gate reads, and opens with a status
// line `watch-pr` reads. The live copy carries both too since #383 (byte-identical, above).
// The verdict grammar is the GATE's, extracted from its `VERDICT_AWK`, never retyped here: a
// prompt that teaches one spelling while the gate parses another merges nothing, silently.
const REVIEW_TEMPLATE = ".github/workflows/reusable-claude-code-review.yml";
const gateVerdictRe = () => {
  const m = shellVar(mergeScript(), "VERDICT_AWK").match(/!fence && \/(\^VERDICT: [^/]*\$)\/ \{ print \}/);
  assert.ok(m, "could not extract the verdict regex from VERDICT_AWK — its spelling changed");
  return new RegExp(m[1]);
};
// What `watch-pr` and the panel match the status line with (design § 3 *Status line*).
const STATUS_READER_RE = /^Round [0-9]+ of [0-9]+ · VERDICT: /;
const promptLines = (src) => promptBlock(src).split("\n").map((l) => l.trim());

test("the review prompt tags every finding and reports from 50, blocking from 75 (Req 1.1, 1.3)", () => {
  const src = collapsed(promptBlock(readWorkflow(REVIEW_TEMPLATE)));
  assert.match(src, /`\[blocking\]` when it scored 75 or above/, "the blocking tag and its threshold");
  assert.match(src, /`\[non-blocking\]` when it scored 50–74/, "the non-blocking tag and its band");
  assert.match(src, /ONE bullet that carries its score and a tag/, "one bullet per finding, score and tag on it");
  assert.match(src, /report every finding scored 50 or above/, "the reporting floor is 50, so the issue after a merge carries the rest");
  assert.doesNotMatch(src, /report only those at 75 or above/, "the old 75 reporting floor is gone");
  // The anchors are what the tags are cut from; lowering the floor must not have dropped them.
  for (const anchor of ["0 =", "25 =", "50 =", "75 =", "100 ="]) assert.ok(src.includes(anchor), `the ${anchor} anchor`);
});

test("the review prompt opens with one status line below the action's header (Req 1.5)", () => {
  const raw = readWorkflow(REVIEW_TEMPLATE);
  const src = collapsed(promptBlock(raw));
  assert.match(src, /FIRST line of your own text/);
  assert.match(src, /below the "Claude finished/, "the action writes its header above the reviewer's text");
  assert.match(src, /exactly once, outside any code fence/);
  const verdict = gateVerdictRe();
  const status = promptLines(raw).filter((l) => l.startsWith("Round "));
  assert.ok(status.length >= 2, `expected the CLEAN and BLOCKING status examples, found:\n${status.join("\n")}`);
  for (const line of status) {
    const m = line.match(/^Round \$\{\{ steps\.round\.outputs\.n \}\} of \$\{\{ steps\.round\.outputs\.budget \}\} · (VERDICT: .*)$/);
    assert.ok(m, `the status line must take n and budget from the round step: ${line}`);
    assert.match(m[1], verdict, `the status line's verdict must be in the gate's grammar: ${line}`);
    // Rendered as the action will render it, the reader matches it and the GATE does not — the
    // gate counts verdict lines and refuses anything but exactly one.
    const rendered = line.replace("${{ steps.round.outputs.n }}", "2").replace("${{ steps.round.outputs.budget }}", "3");
    assert.match(rendered, STATUS_READER_RE);
    assert.doesNotMatch(rendered, verdict, "the status line must not itself count as the gate's verdict line");
  }
});

// The comment is public mid-run: a verdict written before the checklist is done reads as a
// finished review to a person, so the in-progress status line carries no verdict for any reader.
test("the review prompt writes no verdict until its final update", () => {
  const src = collapsed(promptBlock(readWorkflow(REVIEW_TEMPLATE)));
  assert.match(src, /WRITE NO VERDICT UNTIL THE REVIEW IS DONE/);
  const m = src.match(/reads `(Round \$\{\{ steps\.round\.outputs\.n \}\} of \$\{\{ steps\.round\.outputs\.budget \}\} · [^`]+)`/);
  assert.ok(m, "the prompt must spell out the in-progress status line");
  const rendered = m[1].replace("${{ steps.round.outputs.n }}", "1").replace("${{ steps.round.outputs.budget }}", "3");
  assert.doesNotMatch(rendered, STATUS_READER_RE, "the in-progress line must not read as a status line");
  assert.doesNotMatch(rendered, gateVerdictRe(), "nor as the gate's verdict line");
  assert.match(src, /holds no `VERDICT:` line at all/);
  assert.match(src, /Only the final update, with every checklist box ticked/);
});

// A review that ticked its checklist but never made the final update leaves no verdict; the
// verify step fails that round itself, with the gate's own program so the two cannot disagree.
test("the verify step fails a finished checklist with no verdict line, by the gate's program", () => {
  const prog = awkProgram(readWorkflow(GATE_WF), "verdicts");
  const norm = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  assert.equal(norm(prog), norm(shellVar(mergeScript(), "VERDICT_AWK")), "the verify step's verdict program must be the gate's VERDICT_AWK");
  const placeholder = ["Round 1 of 3 · Reviewing…", "", "### Review checklist", "- [x] a", "- [x] b"].join("\n");
  assert.deepEqual(runAwk(prog, placeholder), [], "an in-progress comment holds no verdict");
  assert.match(readWorkflow(GATE_WF), /if \[ "\$nverdicts" -eq 0 \]; then\n\s*echo "::error::[^"]*UNREVIEWED[^"]*"\n\s*exit 1/);
  assert.match(readWorkflow(GATE_WF), /if \[ "\$nverdicts" -ne 1 \]; then\n\s*echo "::error::[^"]*UNREVIEWED[^"]*"\n\s*exit 1/);
});

// The verdict and status checks run as shipped, from the verdict count to the success echo, so a
// comment that keeps `Reviewing…`, repeats or malforms the status line, or disagrees with the
// comment's verdict line fails the round (#490) — and a good one passes.
test("the verify step requires one status line matching the round and the verdict (#490)", () => {
  const src = readWorkflow(GATE_WF);
  // The run below injects the numbers, so the step's env must really carry the round step's.
  assert.match(src, /\n\s*ROUND_N: \$\{\{ steps\.round\.outputs\.n \}\}\n\s*ROUND_BUDGET: \$\{\{ steps\.round\.outputs\.budget \}\}\n/);
  assert.match(src, /\n\s*id: round\n/);
  assert.match(src, /echo "n=\$n" >> "\$GITHUB_OUTPUT"\n\s*echo "budget=\$budget" >> "\$GITHUB_OUTPUT"/);
  const m = /\n(\s*verdicts=\$\(printf[\s\S]*?\n\s*echo "Review completed:[^\n]*)\n/.exec(src);
  assert.ok(m, "could not extract the verify step's verdict and status checks — their spelling changed");
  const run = (lines) => spawnSync("bash", ["-c", m[1]], {
    env: { ...process.env, body: lines.join("\n"), RUN_ID: "1", ROUND_N: "2", ROUND_BUDGET: "3" }, encoding: "utf8",
  });
  const tail = ["### Review checklist", "- [x] a", "", "VERDICT: BLOCKING 1"];
  const good = run(["Round 2 of 3 · VERDICT: BLOCKING 1", ...tail]);
  assert.equal(good.status, 0, good.stdout);
  const fenced = run(["Round 2 of 3 · VERDICT: BLOCKING 1", "```", "Round 2 of 3 · Reviewing…", "```", ...tail]);
  assert.equal(fenced.status, 0, `a fenced status line is not counted: ${fenced.stdout}`);
  // Each shape to the message its own branch prints, so a dropped branch cannot hide behind another.
  const bad = [
    ["no verdict line", ["Round 2 of 3 · Reviewing…", "### Review checklist", "- [x] a"], /holds no verdict line/],
    ["two verdict lines", ["Round 2 of 3 · VERDICT: BLOCKING 1", "VERDICT: CLEAN", ...tail], /holds 2 verdict lines/],
    ["no status line", tail, /holds no status line/],
    ["Reviewing… kept beside the swap", ["Round 2 of 3 · Reviewing…", "Round 2 of 3 · VERDICT: BLOCKING 1", ...tail], /holds 2 status lines/],
    ["status line repeated", ["Round 2 of 3 · VERDICT: BLOCKING 1", "Round 2 of 3 · VERDICT: BLOCKING 1", ...tail], /holds 2 status lines/],
    ["malformed status verdict", ["Round 2 of 3 · VERDICT: pending", ...tail], /status line does not read/, true],
    ["status disagrees with the comment's verdict line", ["Round 2 of 3 · VERDICT: CLEAN", ...tail], /status line does not read/, true],
    ["reviewer's own round numbers", ["Round 7 of 9 · VERDICT: BLOCKING 1", ...tail], /status line does not read/, true],
    ["a carriage return inside the status line", ["Round 2 of 3 · x\r::warning::injected", ...tail], /status line does not read/, true],
  ];
  for (const [name, lines, message, printsLine] of bad) {
    const r = run(lines);
    assert.equal(r.status, 1, `${name} must fail the round`);
    assert.match(r.stdout, /^::error::[^\n]*UNREVIEWED/m, `${name} must say UNREVIEWED`);
    assert.match(r.stdout, message, `${name} must print its own branch's message`);
    // A mismatch prints the line it found, so a malformed verdict, a disagreement and made-up
    // numbers (one message) are told apart — inside a stop-commands fence, because a lone \r in
    // the reviewer's line ends a line for the runner, which would read what follows as a command.
    if (printsLine) {
      const fence = /::stop-commands::(stopcmd-[0-9a-f]{32})\n([^\n]*)\n::\1::\n/.exec(r.stdout);
      assert.ok(fence, `${name} must print the status line it found inside a stop-commands fence`);
      assert.equal(fence[2], lines[0], `${name} must print the status line it found`);
    }
  }
  // The prompt keeps every other `Round <n> of <b> · ` line inside a fence, since the pass counts them.
  assert.match(collapsed(promptBlock(src)), /status line is the only line outside a code fence that starts `Round <n> of <b> · ` \(only a ``` fence counts; a ~~~ fence is not read as one\)/);
});

test("the review prompt ends on one verdict line in the gate's exact grammar (Req 1.2)", () => {
  const raw = readWorkflow(REVIEW_TEMPLATE);
  const verdict = gateVerdictRe();
  const finals = promptLines(raw).filter((l) => verdict.test(l));
  assert.ok(finals.includes("VERDICT: CLEAN"), "the prompt must show `VERDICT: CLEAN` on a line of its own");
  assert.ok(finals.some((l) => /^VERDICT: BLOCKING [1-9]/.test(l)), "and a `VERDICT: BLOCKING <k>` example");
  const src = collapsed(promptBlock(raw));
  assert.match(src, /LAST line of the comment/);
  assert.match(src, /STILL OPEN ones included/, "k counts earlier rounds' open blockers too");
  // End to end: a comment built from the prompt's own example lines, as the action posts it,
  // yields exactly one verdict to the gate's real awk program.
  const status = promptLines(raw).find((l) => l.startsWith("Round ") && l.endsWith("CLEAN"))
    .replace("${{ steps.round.outputs.n }}", "1").replace("${{ steps.round.outputs.budget }}", "3");
  const comment = ["**Claude finished @x's task in 2m** —— [View job](https://github.com/o/r/actions/runs/1)", "", status,
    "", "### Review checklist", "- [x] review", "", "### Findings", "- [non-blocking] (score 50) a nit", "", "VERDICT: CLEAN"];
  assert.deepEqual(runAwk(shellVar(mergeScript(), "VERDICT_AWK"), comment.join("\n")), ["VERDICT: CLEAN"]);
});

test("the round step runs before the review and counts this PR's uncancelled runs (Req 1.5)", () => {
  const src = readWorkflow(REVIEW_TEMPLATE);
  const step = stepWithId(src, "round");
  assert.ok(step, "no step with id: round");
  assert.ok(src.indexOf(step) < src.indexOf(stepWithId(src, "review")), "the round step must run before the review");
  const [script] = runBlocks(step);
  assert.ok(script, "the round step has no run block");
  assert.doesNotMatch(script, /\$\{\{/, "values reach the shell through env, never interpolated into run:");
  assert.match(script, /gh run list/);
  assert.match(script, /--limit \d+/, "gh run list defaults to 20 runs — a long PR would undercount");
  assert.match(script, /--event pull_request/);
  assert.match(step, /BUDGET: \$\{\{ inputs\.round-budget \}\}/);

  // Run it against a fake `gh` that answers with a fixture through real jq, as gh's --jq would.
  const dir = mkdtempSync(join(tmpdir(), "round-"));
  try {
    const runs = [
      { status: "in_progress", conclusion: "", createdAt: "2026-10-16T18:00:00Z" }, // this run
      { status: "completed", conclusion: "success", createdAt: "2026-10-16T17:00:00Z" },
      { status: "completed", conclusion: "failure", createdAt: "2026-10-16T16:00:00Z" }, // a failed review is still a round
      { status: "completed", conclusion: "cancelled", createdAt: "2026-10-16T15:00:00Z" }, // a push cancelled it: not a round
      { status: "completed", conclusion: "skipped", createdAt: "2026-10-16T14:00:00Z" }, // the job never ran: not a round
      { status: "completed", conclusion: "success", createdAt: "2026-10-16T02:47:00Z" }, // an earlier PR on a reused branch name: not a round (#602)
    ];
    writeFileSync(join(dir, "runs.json"), JSON.stringify(runs));
    writeFileSync(join(dir, "gh"), [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$FAKE_DIR/args"',
      'while [ $# -gt 0 ]; do [ "$1" = --jq ] && exec jq -r "$2" "$FAKE_DIR/runs.json"; shift; done',
      "cat \"$FAKE_DIR/runs.json\"",
    ].join("\n"));
    chmodSync(join(dir, "gh"), 0o755);
    // `gh run list` shows a re-run as ONE run (its latest attempt), so the attempts beyond the
    // first are added from GITHUB_RUN_ATTEMPT, a default env var on the runner.
    const run = (budget, attempt = "1") => {
      const out = join(dir, "out");
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-e"], {
        input: script,
        encoding: "utf8",
        env: {
          ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, GITHUB_OUTPUT: out,
          GH_TOKEN: "x", REPO: "o/r", HEAD_REF: "feat/$(touch pwned)", PR_CREATED_AT: "2026-10-16T12:00:00Z",
          GITHUB_WORKFLOW_REF: "o/r/.github/workflows/claude-code-review.yml@refs/pull/7/merge", BUDGET: budget,
          GITHUB_RUN_ATTEMPT: attempt,
        },
      });
      assert.equal(r.status, 0, `the round step failed:\n${r.stdout}${r.stderr}`);
      return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=")));
    };
    assert.deepEqual(run("5"), { n: "3", budget: "5" }, "3 uncancelled runs, budget from the variable");
    assert.deepEqual(run(""), { n: "3", budget: "3" }, "no variable (no auto-merge): budget 3");
    assert.deepEqual(run("0"), { n: "3", budget: "3" }, "not a whole number ≥ 1: budget 3, as watch-pr reads it");
    assert.deepEqual(run("5", "3"), { n: "5", budget: "5" }, "this run's third attempt adds two re-run rounds");
    const args = readFileSync(join(dir, "args"), "utf8").split("\n");
    for (const [flag, value] of [["--workflow", "claude-code-review.yml"], ["--branch", "feat/$(touch pwned)"],
      ["--event", "pull_request"], ["--repo", "o/r"]]) {
      assert.equal(args[args.indexOf(flag) + 1], value, `gh run list ${flag}`);
    }
    assert.ok(!existsSync(join(dir, "..", "pwned")) && !existsSync("pwned"), "the branch name was executed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Spec 20 § 2's extra stops (Req 2.1, 2.8–2.12). The gate's stop-or-merge choice is a pure shell
// function, `decide`, over facts the reads gathered — so the ORDER of the stops, which is the
// part that goes wrong silently (a stale run labelled, an edited workflow reported as a failed
// review), is run here over fixtures rather than read off the YAML. `comment_body` is the comment
// every stop posts; `REVIEWS_JQ` is the change-request reader.
const STOP_TOKENS = ["needs-human", "review-failed", "merge-refused", "gate-error", "changes-requested"];
const shellFn = (script, name) => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(script);
  assert.ok(m, `could not extract the ${name} function — its spelling in the merge workflow changed`);
  return m[0];
};
const runFn = (fnSrc, call, env) => {
  const r = spawnSync("bash", ["-e"], { input: `${fnSrc}\n${call}\n`, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
// `decide` with the 2.9 exception it calls, which step 11 shares.
const decideFn = () => `${shellFn(mergeScript(), "claude_exception")}\n${shellFn(mergeScript(), "decide")}`;
// A PR the gate merges: every fact as the reads report it for a clean, unmoved, insider PR.
const CLEAN_FACTS = {
  CLAUDE_BOT: /^CLAUDE_BOT='([^']*)'$/m.exec(mergeScript())?.[1],
  failed: "", pr_state: "open", pr_draft: "false", pr_head: "abc", pr_base: "main", author: "MEMBER",
  wf_changed: "", nfiles: "1", pr_files: "1", hits: "", changes: "0", verdicts: "VERDICT: CLEAN",
  HEAD_SHA: "abc", DEFAULT_BRANCH: "main", RUN_CONCLUSION: "success", is_land: "", members: "",
};

test("the gate admits a failed review run, still pinned to the review workflow (Req 2.1, 2.10)", () => {
  const src = readWorkflow(MERGE_WORKFLOW);
  const cond = collapsed(src.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m)[1]);
  assert.match(cond, /github\.event\.workflow_run\.conclusion == 'success' \|\| github\.event\.workflow_run\.conclusion == 'failure'/,
    "a failed review must reach the gate, or it stops nobody");
  for (const pin of ["workflow_run.event == 'pull_request'", "workflow_run.path == '.github/workflows/claude-code-review.yml'",
    "workflow_run.pull_requests[0] != null"]) {
    assert.ok(cond.includes(pin), `the job if lost its pin: ${pin}`);
  }
  assert.doesNotMatch(src, /^\s+actions: write/m,"the gate never re-runs a review — the user does (Req 2.10)");
  assert.match(src, /^ {6}actions: read$/m, "`gh pr checks` reads each check's workflow run — without `actions: read` it fails (#366)");
  assert.match(src, /RUN_CONCLUSION: \$\{\{ github\.event\.workflow_run\.conclusion \}\}/);
});

// Accepted, and written down where the merge happens: a merge made with GITHUB_TOKEN creates no
// new workflow run, so the default branch's `push` workflows do not start for it.
test("the gate records that its GITHUB_TOKEN merge starts no push workflow", () => {
  const script = mergeScript();
  const merge = script.indexOf("gh pr merge");
  const before = script.slice(Math.max(0, merge - 800), merge);
  assert.match(collapsed(before), /GITHUB_TOKEN.*no `push` workflow/);
});

test("the gate's decision over fixtures: order, staleness first, no label for a stale run (Req 2.2, 2.9–2.12)", () => {
  const decide = decideFn();
  const run = (over) => {
    const r = runFn(decide, "decide", { ...CLEAN_FACTS, ...over });
    assert.equal(r.status, 0, `decide failed:\n${r.err}`);
    return r.out.trim();
  };
  const token = (over) => run(over).split(" ")[0];
  assert.equal(run({}), "merge", "a clean, unmoved, insider PR merges");
  // 2.9: the outside author.
  for (const author of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN", ""]) {
    assert.equal(run({ author }), "needs-human outsider", `author_association ${author || "(empty)"} is an outsider`);
  }
  for (const author of ["OWNER", "MEMBER", "COLLABORATOR"]) assert.equal(run({ author }), "merge", `${author} is trusted`);
  // A private org member reads as CONTRIBUTOR to the gate's token: write access trusts them.
  for (const author_perm of ["admin", "write"]) {
    assert.equal(run({ author: "CONTRIBUTOR", author_perm }), "merge", `${author_perm} access is trusted`);
  }
  for (const author_perm of ["read", "none", ""]) {
    assert.equal(run({ author: "CONTRIBUTOR", author_perm }), "needs-human outsider", `${author_perm || "(unread)"} access is not`);
  }
  // claude.yml's own PR (author_association NONE): trusted only in a private repo, as claude[bot],
  // from a claude/ branch — in a public repo anyone can write the issue Claude acted on.
  const claudePr = { author: "NONE", pr_author_login: "claude[bot]", pr_head_ref: "claude/issue-7-1", REPO_PRIVATE: "true" };
  assert.equal(run(claudePr), "merge", "Claude's PR in a private repo merges");
  assert.equal(run({ ...claudePr, REPO_PRIVATE: "false" }), "needs-human outsider", "a public repo keeps the stop");
  assert.equal(run({ ...claudePr, REPO_PRIVATE: "" }), "needs-human outsider", "an unknown visibility keeps the stop");
  assert.equal(run({ ...claudePr, pr_head_ref: "feature/x" }), "needs-human outsider", "only claude/ branches");
  assert.equal(run({ ...claudePr, pr_author_login: "someone" }), "needs-human outsider", "only claude[bot]");
  assert.equal(run({ ...claudePr, hits: ".github/workflows/x.yml" }), "needs-human sensitive", "a sensitive path still stops it");
  // 2.10: a failed run, and a successful one with no single verdict.
  assert.equal(run({ RUN_CONCLUSION: "failure", verdicts: "" }), "review-failed run");
  assert.equal(run({ verdicts: "" }), "review-failed verdict", "no verdict is no longer a quiet skip");
  assert.equal(run({ verdicts: "VERDICT: CLEAN\nVERDICT: BLOCKING 1" }), "review-failed verdict", "two verdicts are none");
  // 2.2 before 2.10: a stale failed run gets no label, whatever else is wrong with it.
  for (const stale of [{ pr_head: "moved" }, { pr_state: "closed" }, { pr_draft: "true" }, { pr_base: "release" }]) {
    assert.equal(run({ ...stale, RUN_CONCLUSION: "failure", verdicts: "" }), "skip stale", `stale ${JSON.stringify(stale)}`);
    assert.equal(run({ ...stale, failed: "reviews", author: "NONE", hits: "x" }), "skip stale",
      "a stale run skips even past a failed read or an outsider");
  }
  // 25 · Req 6.1–6.2: a member's PR into its group branch (D-99) is decided like one into the
  // default branch; any other base is still stale.
  assert.equal(run({ pr_base: "group/foo" }), "merge", "a clean PR into group/* merges");
  assert.equal(run({ pr_base: "release" }), "skip stale", "a non-group, non-default base stays stale");
  // 2.11: a human change request stops a CLEAN verdict.
  assert.equal(run({ changes: "1" }), "changes-requested");
  // 2.12: a failed read stops — but the PR read decides staleness, so its failure alone cannot wait for it.
  assert.equal(run({ failed: "reviews" }), "gate-error reviews");
  assert.equal(run({ failed: "pull-request", pr_state: "", pr_draft: "", pr_head: "", pr_base: "" }), "gate-error pull-request");
  // The other stops, and their precedence: an edited review workflow explains a missing verdict
  // (the action skips such a PR while its run passes), so it is reported first.
  assert.equal(run({ wf_changed: "yes", verdicts: "" }), "needs-human workflow");
  assert.equal(run({ wf_changed: "yes", RUN_CONCLUSION: "failure" }), "needs-human workflow");
  // pulls/files stops at 3000: a list shorter than the PR's changed_files may hide the workflow
  // or a sensitive path, so it fails safe — and before either check, which it would make a guess.
  assert.equal(run({ nfiles: "3000", pr_files: "3400" }), "needs-human toomany");
  assert.equal(run({ nfiles: "3000", pr_files: "3400", wf_changed: "", hits: "" }), "needs-human toomany");
  assert.equal(run({ hits: ".github/x.yml" }), "needs-human sensitive");
  assert.equal(run({ verdicts: "VERDICT: BLOCKING 2" }), "skip blocking", "BLOCKING is the review rounds' to handle");
  // Every outcome is merge, skip, or one of the five tokens.
  for (const over of [{ author: "NONE" }, { RUN_CONCLUSION: "failure" }, { changes: "2" }, { failed: "changed-files" }]) {
    assert.ok(STOP_TOKENS.includes(token(over)), `${run(over)} is not a § 4 token`);
  }
});

// 26 · Req 5.1–5.4: a land PR — head `group/<g>`, base the default branch — squashes with its
// `## Members` section as the commit body, so `git log` on main leads back to every member's PRs.
// Without the section the gate merges nothing; any other PR keeps GitHub's default squash.
test("the gate stops a land PR with no ## Members section, after every other stop (26 · Req 5.2, 5.4)", () => {
  const decide = decideFn();
  const run = (over) => {
    const r = runFn(decide, "decide", { ...CLEAN_FACTS, ...over });
    assert.equal(r.status, 0, `decide failed:\n${r.err}`);
    return r.out.trim();
  };
  assert.equal(run({ is_land: "yes", members: "" }), "needs-human members", "a land PR with no section is not merged");
  assert.equal(run({ is_land: "yes", members: " \n\t\n" }), "needs-human members", "a blank section is none");
  assert.equal(run({ is_land: "yes", members: "| a |" }), "merge", "a land PR with its member list merges");
  assert.equal(run({ is_land: "", members: "" }), "merge", "any other PR needs no section (5.3)");
  assert.equal(run({ is_land: "yes", members: "", verdicts: "VERDICT: BLOCKING 1" }), "skip blocking",
    "the members stop comes after every existing stop — a blocking round is the rounds' to handle");
  assert.equal(run({ is_land: "yes", members: "", pr_head: "moved" }), "skip stale", "staleness still first");
  assert.equal(run({ is_land: "yes", failed: "land-body" }), "gate-error land-body", "a failed body read is a gate error (5.4)");
});

test("the gate reads a land PR's head ref and body, and squashes it with its member list (26 · Req 5.1, 5.3, 5.4)", () => {
  const script = mergeScript();
  assert.match(script, /--jq '\[[^\]]*\.head\.ref[^\]]*\] \| @tsv'\) \|\| fail pull-request/, "read 1 carries .head.ref");
  assert.match(script, /gh api "repos\/\$GH_REPO\/pulls\/\$PR" --jq \.body\) \|\| fail land-body/, "the land body read fails as land-body");
  assert.match(collapsed(script), /case "\$pr_head_ref" in group\/\*\) \[ "\$pr_base" = "\$DEFAULT_BRANCH" \] && is_land=yes/,
    "a land PR is head group/*, base the default branch — a member PR into group/* is not one");
  const land = script.match(/gh pr merge "\$PR" --squash --match-head-commit "\$HEAD_SHA" --subject "feat\(group\): \$\{pr_head_ref#group\/\} \(#\$PR\)" --body-file "\$body_file"/);
  assert.ok(land, "the land merge sets the subject feat(group): <g> (#<PR>) and the member list as body");
  assert.match(script, /merge_cmd=\(gh pr merge "\$PR" --squash --match-head-commit "\$HEAD_SHA"\)/, "any other PR keeps the default squash (5.3)");
  assert.match(script, /"needs-human members"\)\n\s*needs_human needs-human "the land PR has no ## Members section"/, "the members stop posts a needs-human comment");
  // The section extractor: heading to the next `## `, CRLF-safe.
  const prog = shellVar(script, "MEMBERS_AWK");
  const members = (body) => {
    const r = spawnSync("awk", [prog], { input: body, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const body = "What.\n\n- a\n\n## Members\n\n| M | P |\n|---|---|\n| 01-x | #1 |\n\nSynced with main at abc.\n## Key decisions\n- k\n";
  assert.equal(members(body), "\n| M | P |\n|---|---|\n| 01-x | #1 |\n\nSynced with main at abc.\n");
  assert.equal(members(body.replace(/\n/g, "\r\n")), members(body), "a CRLF body reads the same");
  assert.equal(members("## Key decisions\n- k\n"), "", "no section, nothing");
  assert.equal(members("## Membership\nx\n"), "", "only the exact heading");
});

test("every needs-human comment opens with its token and says what to do (Req 2.8)", () => {
  const script = mergeScript();
  const body = shellFn(script, "comment_body");
  // Design § 3's "What the comment tells the user" table, row by row.
  const TODO = {
    "needs-human": /review the listed paths or the author's change yourself; merge it, or push and play/i,
    "review-failed": /open the review run .*; fix the cause and re-run it, then play/i,
    "merge-refused": /fix the named check or refusal, then play/i,
    "changes-requested": /answer the reviewer's request, push, then play/i,
    "gate-error": /re-run the gate run .*, or merge it yourself/i,
  };
  for (const tok of STOP_TOKENS) {
    const r = runFn(body, `comment_body ${tok} "something went wrong" "the detail"`, {});
    assert.equal(r.status, 0, r.err);
    const lines = r.out.split("\n");
    assert.equal(lines[0], `**Not merged: ${tok} — something went wrong.**`, "the opener watch-pr reads (3.2)");
    assert.ok(lines.includes("the detail"), "the detail follows the opener");
    assert.match(r.out, TODO[tok], `${tok}'s what-to-do line`);
  }
  assert.notEqual(runFn(body, 'comment_body needs_human "x" ""', {}).status, 0, "a token outside the five is refused, not posted");
  // Every stop the script posts uses one of the five tokens.
  const calls = [...script.matchAll(/^\s*needs_human (\S+) /gm)].map((m) => m[1]);
  assert.ok(calls.length >= 8, `expected a needs_human call per stop, found ${calls.length}`);
  for (const c of calls) assert.ok(STOP_TOKENS.includes(c), `needs_human ${c} is not a § 4 token`);
  assert.deepEqual(new Set(calls), new Set(STOP_TOKENS), "every token has a stop that posts it");
});

test("the gate reads each reviewer's latest decision, ignoring comments (Req 2.11)", () => {
  const script = mergeScript();
  const prog = shellVar(script, "REVIEWS_JQ");
  assert.match(script, /gh api --paginate "repos\/\$GH_REPO\/pulls\/\$PR\/reviews\?per_page=100"/);
  const rv = (id, login, state, author_association = "MEMBER") => ({ id, user: { login }, state, author_association });
  const changes = (...pages) => {
    const r = spawnSync("jq", ["-s", prog], { input: pages.map((p) => JSON.stringify(p)).join("\n"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stdout.trim());
  };
  assert.equal(changes([]), 0);
  assert.equal(changes(), 0,"no page at all is no change request");
  assert.equal(changes([rv(1, "a", "CHANGES_REQUESTED"), rv(2, "a", "APPROVED")]), 0, "a later approval supersedes");
  assert.equal(changes([rv(1, "a", "CHANGES_REQUESTED"), rv(2, "a", "COMMENTED")]), 1, "a later comment does not");
  assert.equal(changes([rv(1, "a", "DISMISSED")]), 0, "a dismissed request is no request");
  // As GitHub's own reviewDecision: only a reviewer with write access decides.
  assert.equal(changes([rv(1, "x", "CHANGES_REQUESTED", "CONTRIBUTOR"), rv(2, "y", "CHANGES_REQUESTED", "NONE")]), 0,
    "an outsider's change request does not stop the merge");
  for (const assoc of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(changes([rv(1, "a", "CHANGES_REQUESTED", assoc)]), 1, `${assoc}'s change request stops`);
  }
  assert.equal(changes([rv(1, "a", "APPROVED")], [rv(5, "a", "CHANGES_REQUESTED"), rv(6, "b", "CHANGES_REQUESTED")]), 2,
    "across pages, per reviewer");
});

test("every gh read in the gate is checked, and the comment read pages from run_started_at (Req 2.12)", () => {
  const script = mergeScript();
  // A read wrapped in `timeout` is still a gh read.
  for (const line of script.split("\n").filter((l) => /\$\((?:timeout \S+ )?gh /.test(l))) {
    assert.ok(/\|\| fail [a-z-]+$/.test(line) || /^\s*(?:if|elif) /.test(line),
      `this gh read is unchecked, so a failure kills the job under bash -e instead of stopping gate-error:\n    ${line.trim()}`);
  }
  // The issue-comments endpoint ignores sort/direction, so one unpaged read is the OLDEST 100.
  assert.match(script, /gh api --paginate "repos\/\$GH_REPO\/issues\/\$PR\/comments\?per_page=100&since=\$RUN_STARTED_AT"/);
  assert.doesNotMatch(script, /sort=created|direction=desc/, "the endpoint ignores them; they only suggest an order it never gives");
});

// The whole run block end to end, against a fake `gh` answering from fixture files: what the
// unit fixtures above cannot show — that a failed read STOPS rather than dies under `bash -e`,
// that a stale run leaves no trace, and that no PR-controlled text reaches the log.
test("the gate end to end against a fake gh (Req 2.8, 2.10, 2.12)", () => {
  const script = mergeScript();
  const key = (url) => url.replace(/[^A-Za-z0-9]/g, "_");
  const STARTED = "2026-10-06T10:00:00Z";
  const WF = ".github/workflows/claude-code-review.yml";
  const EVIL = ".github/::warning::pwned $(touch pwned).yml";
  const base = {
    "repos/o/r/pulls/7": { state: "open", draft: false, head: { sha: "abc" }, base: { ref: "main" }, author_association: "MEMBER",
      changed_files: 1 },
    "repos/o/r/pulls/7/files?per_page=100": [{ filename: "src/a.js" }],
    "repos/o/r/pulls/7/reviews?per_page=100": [],
    "repos/o/r/branches/spec/30-x": { protected: false },
    "repos/o/r/branches/group/foo": { protected: false },
    "repos/o/r/branches/release": { protected: true },
    [`repos/o/r/issues/7/comments?per_page=100&since=${STARTED}`]: [
      { id: 1, user: { login: "claude[bot]" }, created_at: "2026-10-06T10:00:05Z",
        body: "Claude finished [View job](https://github.com/o/r/actions/runs/99)\n\nVERDICT: CLEAN" },
    ],
  };
  const fakeGh = [
    "#!/bin/sh",
    'echo "$*" >> "$FAKE_DIR/calls"',
    'case "$1" in',
    "  api)",
    '    shift; jq=""; url=""; method=GET',
    '    while [ $# -gt 0 ]; do case "$1" in --paginate) ;; --jq) jq=$2; shift ;; -X) method=$2; shift ;; *) url=$1 ;; esac; shift; done',
    "    f=\"$FAKE_DIR/api/$(printf '%s' \"$url\" | tr -c 'A-Za-z0-9' '_')\"",
    // 31 · step 10's branch delete: recorded, or refused when the test marks it `.delfail`.
    '    if [ "$method" = DELETE ]; then [ -f "$f.delfail" ] && { echo "gh: Reference does not exist (HTTP 422)" >&2; exit 1; }; echo "$url" >> "$FAKE_DIR/deleted"; exit 0; fi',
    '    [ -f "$f.fail" ] && { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }',
    '    [ -f "$f" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }',
    '    if [ -n "$jq" ]; then exec jq -r "$jq" "$f"; else cat "$f"; fi ;;',
    "  pr)",
    '    case "$2" in',
    '      comment) while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_DIR/comment"; shift; done ;;',
    '      edit) echo labelled >> "$FAKE_DIR/labels" ;;',
    // `--watch` reports by exit code alone. The `--json` read prints the list and exits 0 whatever
    // the checks say (gh 2.101); FAKE_CHECKS_JSON_RC plays a gh that returns the plain codes.
    "      checks)",
    '        case "$*" in *--watch*) exit "${FAKE_CHECKS:-0}" ;; esac',
    '        [ -n "$FAKE_CHECKS_FAIL" ] && { echo "$FAKE_CHECKS_FAIL" >&2; exit 1; }',
    '        printf "%s" "$FAKE_CHECKS_JSON"; exit "${FAKE_CHECKS_JSON_RC:-0}" ;;',
    '      merge) echo merged > "$FAKE_DIR/merged"; while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_DIR/mergebody"; shift; done ;;',
    // 31 · step 10's base check: how many open PRs target the head branch.
    '      list) [ -n "$FAKE_BASED_FAIL" ] && { echo "gh: HTTP 502" >&2; exit 1; }; printf "%s\\n" "${FAKE_BASED:-0}" ;;',
    // Step 9's read of the issues the PR closes: FAKE_LINKED is the PR's JSON.
    "      view)",
    '        [ -n "$FAKE_LINKED_FAIL" ] && { echo "gh: Server Error (HTTP 502)" >&2; exit 1; }',
    '        jq=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && jq=$2; shift; done',
    '        printf "%s" "$FAKE_LINKED" | jq -r "$jq" ;;',
    "    esac ;;",
    "  issue)",
    // Step 11's follow-up issue: the body is recorded and a URL printed, as gh does.
    '    if [ "$2" = create ]; then [ -n "$FAKE_ISSUE_FAIL" ] && { echo "gh: HTTP 403" >&2; exit 1; }; while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_DIR/issue"; shift; done; echo "https://github.com/o/r/issues/900"; exit 0; fi',
    '    [ "$2" = close ] || exit 0',
    '    [ "$3" = "$FAKE_CLOSE_FAIL" ] && { echo "gh: HTTP 403" >&2; exit 1; }',
    '    echo "$3" >> "$FAKE_DIR/closed" ;;',
    "esac",
  ].join("\n");
  const gate = ({ over = {}, fail = [], conclusion = "success", checks = "0", sensitive = "",
    checksJson = [{ name: "review", bucket: "pass" }], checksFail = "", checksJsonRc = "0",
    linked = [], linkedFail = false, closeFail = "", headBranch = "spec/30-x", based = "0", basedFail = false, delFail = false, repoPrivate = "", issueFail = false } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    try {
      writeFileSync(join(dir, "gh"), fakeGh);
      chmodSync(join(dir, "gh"), 0o755);
      // `timeout` is GNU coreutils (on the runner, not on macOS): record the limit, run the rest.
      writeFileSync(join(dir, "timeout"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$FAKE_DIR/timeouts"; shift; exec "$@"\n');
      chmodSync(join(dir, "timeout"), 0o755);
      mkdirSync(join(dir, "api"));
      for (const [url, v] of Object.entries({ ...base, ...over })) {
        if (v !== undefined) writeFileSync(join(dir, "api", key(url)), JSON.stringify(v));
      }
      for (const url of fail) writeFileSync(join(dir, "api", key(url) + ".fail"), "");
      if (delFail) writeFileSync(join(dir, "api", key(`repos/o/r/git/refs/heads/${headBranch}`) + ".delfail"), "");
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail"], {
        input: script, encoding: "utf8", cwd: dir,
        env: {
          PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, TMPDIR: dir, GH_TOKEN: "x", GH_REPO: "o/r", PR: "7",
          HEAD_SHA: "abc", RUN_ID: "99", RUN_STARTED_AT: STARTED, RUN_CONCLUSION: conclusion, REVIEW_WORKFLOW: WF,
          DEFAULT_BRANCH: "main", REVIEW_SENSITIVE_PATHS: sensitive, GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "123",
          FAKE_CHECKS: checks, FAKE_CHECKS_JSON: typeof checksJson === "string" ? checksJson : JSON.stringify(checksJson), FAKE_CHECKS_FAIL: checksFail,
          FAKE_CHECKS_JSON_RC: checksJsonRc,
          FAKE_LINKED: JSON.stringify({ closingIssuesReferences: linked.map(([repo, number]) => {
            const [login, name] = repo.split("/");
            return { number, repository: { name, owner: { login } } };
          }) }),
          FAKE_LINKED_FAIL: linkedFail ? "1" : "", FAKE_CLOSE_FAIL: closeFail,
          HEAD_BRANCH: headBranch, REPO_PRIVATE: repoPrivate, FAKE_BASED: based, FAKE_BASED_FAIL: basedFail ? "1" : "",
          FAKE_ISSUE_FAIL: issueFail ? "1" : "",
        },
      });
      const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
      return { status: r.status, log: r.stdout + r.stderr, comment: read("comment"), labels: read("labels"),
        merged: read("merged") !== "", mergeBody: read("mergebody"), pwned: existsSync(join(dir, "pwned")), timeout: read("timeouts"), calls: read("calls"),
        closed: read("closed").split("\n").filter(Boolean), deleted: read("deleted").split("\n").filter(Boolean), issue: read("issue") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const clean = gate();
  assert.equal(clean.status, 0, clean.log);
  assert.ok(clean.merged && !clean.comment && !clean.labels, `a clean PR merges quietly:\n${clean.log}`);
  assert.deepEqual(clean.closed, [], "no linked issue, nothing closed");
  assert.ok(!/--subject|--body-file/.test(clean.calls) && !clean.mergeBody, "any other PR keeps GitHub's default squash (26 · Req 5.3)");

  // 26 · Req 5.1–5.2: a land PR (head group/<g>, base main) squashes with its member list.
  const landPr = (body) => ({ "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], head: { sha: "abc", ref: "group/auth" }, body } });
  const land = gate({ over: landPr("Lands auth.\n\n## Members\n\n| 01-a | #1 | #2 | — |\n\nSynced with main at abc.\n\n## Key decisions\n- k\n") });
  assert.ok(land.merged && !land.labels, `a land PR with its member list merges:\n${land.log}`);
  assert.ok(land.calls.includes("--subject feat(group): auth (#7) --body-file"), `the land squash subject:\n${land.calls}`);
  assert.equal(land.mergeBody, "\n| 01-a | #1 | #2 | — |\n\nSynced with main at abc.\n", "the commit body is the section, heading to the next ##");
  const bare = gate({ over: landPr("Lands auth.\n\n## Key decisions\n- k\n") });
  assert.ok(!bare.merged && bare.labels, "a land PR with no ## Members section is not merged");
  assert.match(bare.comment, /^\*\*Not merged: needs-human — the land PR has no ## Members section\.\*\*\n[\s\S]*\/spec-workflow:land auth/);
  const member = gate({ over: { "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], head: { sha: "abc", ref: "group/auth" }, base: { ref: "group/x" } } } });
  assert.ok(member.merged && !/--subject/.test(member.calls), "a PR between group branches is no land PR");

  // Step 9: a GITHUB_TOKEN merge does not close `Closes #n` issues, so the gate closes this repo's.
  const linking = gate({ linked: [["o/r", 12], ["o/r", 13], ["other/repo", 14]] });
  assert.ok(linking.merged, linking.log);
  assert.deepEqual(linking.closed, ["12", "13"], "this repo's linked issues closed; another repo's #14 never");
  const noMerge = gate({ checks: "1", checksJson: [{ name: "lint", bucket: "fail" }], linked: [["o/r", 12]] });
  assert.deepEqual(noMerge.closed, [], "a stop closes nothing");
  // The PR is merged already: a failed read or close is a warning, never a stop or a failed job.
  const unreadLinks = gate({ linked: [["o/r", 12]], linkedFail: true });
  assert.ok(unreadLinks.status === 0 && unreadLinks.merged && !unreadLinks.labels, unreadLinks.log);
  assert.match(unreadLinks.log, /::warning::Could not read the issues PR #7 closes/);
  const refused = gate({ linked: [["o/r", 12], ["o/r", 13]], closeFail: "12" });
  assert.equal(refused.status, 0, refused.log);
  assert.deepEqual(refused.closed, ["13"], "one refused close does not stop the next");
  assert.match(refused.log, /::warning::Could not close issue #12\./);

  // 31 · Step 10 (Req 16.1–16.4): a GITHUB_TOKEN merge skips GitHub's own head-branch delete, so
  // the gate deletes it — never the default or a protected branch, nor one an open PR targets.
  assert.deepEqual(clean.deleted, ["repos/o/r/git/refs/heads/spec/30-x"], `the merged head is deleted:\n${clean.log}`);
  assert.deepEqual(gate({ headBranch: "group/foo" }).deleted, ["repos/o/r/git/refs/heads/group/foo"], "a landed group branch no open PR targets");
  for (const [o, why] of [[{ headBranch: "main" }, "it is the default branch"], [{ headBranch: "release" }, "it is protected"],
    [{ headBranch: "group/foo", based: "2" }, "2 open PR\\(s\\) target it"]]) {
    const g = gate(o);
    assert.ok(g.status === 0 && g.merged && !g.labels && !g.comment && g.deleted.length === 0, `${why}:\n${g.log}`);
    assert.match(g.log, new RegExp(`::notice::Kept branch ${o.headBranch}: ${why}\\.`), g.log);
  }
  // Every failure is a warning, never a stop: the PR is merged.
  for (const [o, re] of [[{ fail: ["repos/o/r/branches/spec/30-x"] }, /::warning::Could not read whether spec\/30-x may be deleted/],
    [{ basedFail: true }, /::warning::Could not read whether spec\/30-x may be deleted/],
    [{ delFail: true }, /::warning::Could not delete branch spec\/30-x/]]) {
    const g = gate(o);
    assert.ok(g.status === 0 && g.merged && !g.labels && !g.comment && g.deleted.length === 0, `${re}:\n${g.log}`);
    assert.match(g.log, re);
  }
  assert.deepEqual(gate({ checks: "1", checksJson: [{ name: "lint", bucket: "fail" }] }).deleted, [], "a stop deletes nothing");

  const broken = gate({ fail: ["repos/o/r/pulls/7/reviews?per_page=100"] });
  assert.equal(broken.status, 0, `a failed read must stop, not kill the job:\n${broken.log}`);
  assert.ok(!broken.merged && broken.labels, "a failed read is a labelled stop");
  assert.match(broken.comment, /^\*\*Not merged: gate-error — .*`reviews`.*\.\*\*\n/, "the comment names the failed read");

  const failed = gate({ conclusion: "failure" });
  assert.match(failed.comment, /^\*\*Not merged: review-failed — /);
  assert.match(failed.comment, /https:\/\/github\.com\/o\/r\/actions\/runs\/99/, "the review run's link");
  assert.ok(failed.labels && !failed.merged);

  const stale = gate({ conclusion: "failure", over: { "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], head: { sha: "new" } } } });
  assert.equal(stale.status, 0, stale.log);
  assert.ok(!stale.comment && !stale.labels && !stale.merged, "a stale run leaves no comment, no label, no merge");

  const silent = gate({ over: { [`repos/o/r/issues/7/comments?per_page=100&since=${STARTED}`]: [] } });
  assert.match(silent.comment, /^\*\*Not merged: review-failed — /, "a comment with no verdict is a stop, not a skip");

  // The review workflow is judged from the PR's own file list, not by comparing blobs: a PR
  // merely BEHIND a default branch that updated it runs the default's copy (a pull_request run
  // uses the merge ref) and must still merge — and the gate reads no workflow blob at all.
  assert.ok(clean.merged && !/contents\//.test(clean.calls), "no blob comparison: a PR behind the base still merges");
  const files = (list) => ({ "repos/o/r/pulls/7/files?per_page=100": list,
    "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], changed_files: list.length } });
  for (const [what, list] of [
    ["edited", [{ filename: WF, status: "modified" }]],
    ["deleted", [{ filename: WF, status: "removed" }]],
    ["renamed away", [{ filename: "docs/old-review.yml", previous_filename: WF, status: "renamed" }]],
  ]) {
    const r = gate({ over: files(list), sensitive: "docs/" });
    assert.match(r.comment, /^\*\*Not merged: needs-human — this PR changes the review workflow/, `a ${what} review workflow`);
    assert.ok(!r.merged);
  }
  // Renaming a sensitive file away is a change to it.
  const away = gate({ over: files([{ filename: "docs/x.md", previous_filename: ".claude/rules/x.md", status: "renamed" }]) });
  assert.match(away.comment, /^\*\*Not merged: needs-human — it changes sensitive paths/);
  assert.ok(away.comment.includes(".claude/rules/x.md"), "the comment names the old path");
  // pulls/files caps at 3000: a short list fails safe.
  const capped = gate({ over: { "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], changed_files: 3400 } } });
  assert.match(capped.comment, /^\*\*Not merged: needs-human — too many files to check/);
  assert.ok(!capped.merged);

  const evil = gate({ over: { "repos/o/r/pulls/7/files?per_page=100": [{ filename: EVIL }] } });
  assert.match(evil.comment, /^\*\*Not merged: needs-human — /);
  assert.ok(evil.comment.includes(EVIL), "the comment names the path");
  assert.ok(!evil.log.includes("pwned") && !evil.pwned, `no PR-controlled text in the log, none executed:\n${evil.log}`);

  const red = gate({ checks: "1", checksJson: [{ name: "review", bucket: "pass" }, { name: "lint", bucket: "fail" }] });
  assert.match(red.comment, /^\*\*Not merged: merge-refused — a check on the head is not green/, "a red check is a refused merge");
  assert.ok(red.comment.includes("lint (fail)"), `the comment names the red check:\n${red.comment}`);
  assert.ok(red.comment.includes("actions/runs/123"), "the comment links the gate run");
  assert.ok(!red.merged);

  // `--watch` exits 1 for a failed read as well as a red check: the `--json` read tells them apart.
  const unread = gate({ checks: "1", checksFail: "gh: Server Error (HTTP 502)" });
  assert.equal(unread.status, 0, unread.log);
  assert.match(unread.comment, /^\*\*Not merged: gate-error — .*`checks`.*\.\*\*\n/, "a failed checks read is a gate error, not a red check");
  assert.ok(unread.labels && !unread.merged);

  const skipped = gate({ checksJson: [{ name: "review", bucket: "pass" }, { name: "deploy", bucket: "skipping" }] });
  assert.ok(skipped.merged && !skipped.comment, `a skipped check is not a red one:\n${skipped.comment}`);

  // A gh that returned the plain codes on `--json` (1 red) must still read as a red check (#377).
  const plainRc = gate({ checks: "1", checksJsonRc: "1", checksJson: [{ name: "lint", bucket: "fail" }] });
  assert.match(plainRc.comment, /^\*\*Not merged: merge-refused — a check on the head is not green/, "the JSON decides, not the exit code");
  assert.ok(plainRc.labels && !plainRc.merged);
  const empty = gate({ checksJson: [] });
  assert.match(empty.comment, /^\*\*Not merged: merge-refused — no checks reported on the head/, "an empty list is no checks, not a pass");
  assert.ok(!empty.merged);
  // Malformed entries are a labelled stop, never a jq error that kills the job unseen.
  const odd = gate({ checksJson: ["x", { name: 7, bucket: "pass" }] });
  assert.equal(odd.status, 0, odd.log);
  assert.match(odd.comment, /^\*\*Not merged: merge-refused — a check on the head is still pending/);
  assert.ok(odd.labels && !odd.merged);

  // gh's own wording when the head has no checks at all (probed on gh 2.101).
  const none = gate({ checks: "1", checksFail: "no checks reported on the 'fix/x' branch" });
  assert.match(none.comment, /^\*\*Not merged: merge-refused — no checks reported on the head/, "no checks is not a failed read");
  assert.ok(none.labels && !none.merged);

  // The watch broke early (its own read failed) while CI still ran: nothing was decided.
  const early = gate({ checks: "1", checksJson: [{ name: "ci", bucket: "pending" }] });
  assert.match(early.comment, /^\*\*Not merged: gate-error — .*`checks`/, "a pending check after a broken watch is a gate error");
  assert.ok(early.comment.includes("ci (pending)") && !early.merged);

  // The watch finished green, then a check (re-)started before the `--json` read.
  const late = gate({ checks: "0", checksJson: [{ name: "review", bucket: "pass" }, { name: "ci", bucket: "pending" }] });
  assert.match(late.comment, /^\*\*Not merged: merge-refused — a check on the head is still pending/, "a check started after the wait is not green");
  assert.ok(!late.merged);
  const lateRed = gate({ checks: "0", checksJson: [{ name: "ci", bucket: "fail" }] });
  assert.match(lateRed.comment, /^\*\*Not merged: merge-refused — a check on the head is not green/, "a green watch does not excuse a red read");
  assert.ok(lateRed.labels && !lateRed.merged);

  // A check name cannot close the fence the comment puts it in.
  const fence = gate({ checks: "1", checksJson: [{ name: "x```\n**injected**\tz", bucket: "fail" }] });
  assert.equal((fence.comment.match(/```/g) || []).length, 2, `one fence, opened and closed once:\n${fence.comment}`);
  assert.match(fence.comment, /^\*\*Not merged: merge-refused — a check on the head is not green/);
  assert.ok(fence.comment.includes("x **injected** z (fail)") && fence.labels && !fence.merged, fence.comment);

  // #379: a gh returning plain codes on `--json` — 8 for pending, 1 with an empty list.
  const rc8 = gate({ checks: "0", checksJsonRc: "8", checksJson: [{ name: "ci", bucket: "pending" }] });
  assert.match(rc8.comment, /^\*\*Not merged: merge-refused — a check on the head is still pending/, "exit 8 with JSON is still the JSON's");
  const emptyRc = gate({ checks: "1", checksJsonRc: "1", checksJson: [] });
  assert.match(emptyRc.comment, /^\*\*Not merged: merge-refused — no checks reported on the head/);
  // `[]` followed by junk is no list at all: a failed read, not "no checks".
  const junk = gate({ checks: "1", checksJson: "[] trailing" });
  assert.match(junk.comment, /^\*\*Not merged: gate-error — .*`checks`/, `junk after []:\n${junk.comment}`);
  assert.ok(junk.labels && !junk.merged);
  // The failed read's own words reach the log the comment links, prefixed so no line is a workflow command.
  assert.ok(unread.log.includes("gh: gh: Server Error (HTTP 502)"), unread.log);
  const cmd = gate({ checks: "1", checksFail: "::error::spoofed" });
  assert.ok(cmd.log.includes("gh: ::error::spoofed") && !/^::error::spoofed/m.test(cmd.log), cmd.log);

  // `--watch` has no limit; the job's timeout-minutes would kill it with no label or comment.
  // 124 is what `timeout` exits with when the limit expires.
  const jobMinutes = Number(readWorkflow(MERGE_WORKFLOW).match(/timeout-minutes: (\d+)/)[1]);
  // Two capped calls, in order: the watch, then the `--json` read (#379) — together under the job's limit.
  const [watchCap, readCap] = clean.timeout.trim().split("\n");
  const watchMinutes = Number(watchCap?.match(/^(\d+)m$/)?.[1]);
  const readMinutes = Number(readCap?.match(/^(\d+)m$/)?.[1]);
  assert.ok(watchMinutes > 0 && readMinutes > 0 && watchMinutes + readMinutes < jobMinutes,
    `the checks wait and read (${clean.timeout.trim()}) must be capped below the job's ${jobMinutes} minutes, leaving room to stop`);
  const pending = gate({ checks: "124" });
  assert.equal(pending.status, 0, pending.log);
  assert.match(pending.comment, new RegExp(`^\\*\\*Not merged: merge-refused — checks are still pending after ${watchMinutes} min\\.\\*\\*`),
    "checks still pending at the cap are a labelled stop, not a silently killed job");
  assert.ok(pending.labels && !pending.merged);

  const contributor = { "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], author_association: "CONTRIBUTOR",
    head: { sha: "abc", ref: "feature/x" }, user: { login: "jane-doe" } } };
  const perm = "repos/o/r/collaborators/jane-doe/permission";
  const outsider = gate({ over: contributor });
  assert.match(outsider.comment, /^\*\*Not merged: needs-human — /);
  assert.ok(!outsider.merged);
  assert.match(outsider.log, /Outsider: author_association=CONTRIBUTOR, permission=none, login=jane-doe\./,
    "a 404 is no access, and the stop logs what it read");
  const readOnly = gate({ over: { ...contributor, [perm]: { permission: "read" } } });
  assert.ok(!readOnly.merged && /permission=read/.test(readOnly.log), "read access is still an outsider");
  // A private org member: the association hides them, the permission does not.
  const privateMember = gate({ over: { ...contributor, [perm]: { permission: "admin" } } });
  assert.ok(privateMember.merged && !privateMember.labels, `write or admin access merges:\n${privateMember.log}`);
  const unreadPerm = gate({ over: contributor, fail: [perm] });
  assert.match(unreadPerm.comment, /^\*\*Not merged: gate-error — the gate could not read `author-permission`/, "a failed read is not a 404");
  assert.ok(!unreadPerm.merged);
  assert.doesNotMatch(clean.calls, /collaborators/, "a trusted association reads no permission");
  // The login and head ref come from the same PR read as the association, as its last columns.
  const claudePr = { "repos/o/r/pulls/7": { ...base["repos/o/r/pulls/7"], author_association: "NONE",
    head: { sha: "abc", ref: "claude/issue-7-1" }, user: { login: "claude[bot]" } } };
  const trusted = gate({ over: claudePr, repoPrivate: "true", headBranch: "claude/issue-7-1" });
  assert.ok(trusted.merged && !trusted.labels, `Claude's PR in a private repo merges:\n${trusted.log}`);
  assert.equal(trusted.issue, "", "a review with no non-blocking finding files nothing");

  // Step 11: Claude's merged PR files its non-blocking leftovers, which no watch-pr would.
  const withLeftovers = { ...claudePr, [`repos/o/r/issues/7/comments?per_page=100&since=${STARTED}`]: [
    { id: 1, user: { login: "claude[bot]" }, created_at: "2026-10-06T10:00:05Z", html_url: "https://github.com/o/r/pull/7#issuecomment-1",
      body: "Claude finished [View job](https://github.com/o/r/actions/runs/99)\n\nRound 1 of 5 · VERDICT: CLEAN\n\n" +
        "- [non-blocking] (50) **Stale doc** `a.md:3`\n  its scenario, see #12 and @owner\n\nVERDICT: CLEAN" },
  ] };
  const filed = gate({ over: withLeftovers, repoPrivate: "true", headBranch: "claude/issue-7-1" });
  assert.ok(filed.merged, filed.log);
  assert.match(filed.issue, /^Non-blocking review findings left open when the auto-merge gate merged #7 .*From the final review: https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-1\n/,
    "the link is the review comment, not the run");
  assert.match(filed.issue, /\n- \[ \] \[non-blocking\] \(50\) \*\*Stale doc\*\* `a\.md:3`\n {2}its scenario, see #​12 and @​owner\n/,
    "each finding a checklist item; no mention or cross-reference survives");
  assert.match(filed.calls, /pr comment 7 --body Follow-ups filed: https:\/\/github\.com\/o\/r\/issues\/900/, "linked on the PR");
  // 2.13: a failed filing is a warning on a merged PR, never a failed job, and links nothing.
  const unfiled = gate({ over: withLeftovers, repoPrivate: "true", headBranch: "claude/issue-7-1", issueFail: true });
  assert.ok(unfiled.merged && unfiled.status === 0, unfiled.log);
  assert.match(unfiled.log, /::warning::Could not file PR #7's non-blocking findings; they are in the review comment: https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-1/);
  assert.doesNotMatch(unfiled.calls, /Follow-ups filed/, "nothing filed, nothing linked");
  const person = gate({ over: { [`repos/o/r/issues/7/comments?per_page=100&since=${STARTED}`]: withLeftovers[`repos/o/r/issues/7/comments?per_page=100&since=${STARTED}`] } });
  assert.ok(person.merged && person.issue === "", "a person's PR is left to watch-pr");
  const publicRepo = gate({ over: claudePr, repoPrivate: "false", headBranch: "claude/issue-7-1" });
  assert.ok(!publicRepo.merged, "a public repo keeps the outsider stop");
  assert.match(publicRepo.comment, /^\*\*Not merged: needs-human — the author is not an owner/);
});

// The review fixer: agent mode on `workflow_run`, so it is not in WORKFLOWS (track_progress is
// tag-mode only and the action refuses it on this event). It must act on Claude's own PRs and
// nothing else, and hand the PR to a person once the review budget is spent.
const FIX_WORKFLOW = ".github/workflows/reusable-claude-review-fix.yml";
// Run blocks in step order: the round step, the PR-body refresh, then the hand-off to a person.
const fixBlocks = () => {
  const blocks = runBlocks(readWorkflow(FIX_WORKFLOW));
  assert.equal(blocks.length, 3, "the fix workflow has three run blocks");
  return blocks;
};
const fixScript = () => fixBlocks()[0];

// A fix can make the PR body untrue (#471's walk). Claude writes the new body to a file; the step
// applies it with github.token, so Claude's own allowlist never holds `gh pr edit`.
test("the fix workflow refreshes the PR body from Claude's file, and only from it", () => {
  const run = (content) => {
    const dir = mkdtempSync(join(tmpdir(), "body-"));
    try {
      writeFileSync(join(dir, "gh"), '#!/bin/sh\necho "$*" >> "$FAKE_DIR/calls"\nwhile [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_DIR/applied"; shift; done\n');
      chmodSync(join(dir, "gh"), 0o755);
      if (content !== undefined) writeFileSync(join(dir, "claude-review-fix-body.md"), content);
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail"], {
        input: fixBlocks()[1], encoding: "utf8", cwd: dir,
        env: { PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, PR: "7", GH_REPO: "o/r", BODY_FILE: "claude-review-fix-body.md" },
      });
      const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
      return { status: r.status, log: r.stdout + r.stderr, calls: read("calls"), applied: read("applied") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const none = run(undefined);
  assert.ok(none.status === 0 && !none.calls, `no body file, no edit:\n${none.log}`);
  const given = run("Reverts the sentence.\n\nRefs #483\n");
  assert.equal(given.status, 0, given.log);
  assert.match(given.calls, /^pr edit 7 --body-file /, "the body is applied to this PR");
  assert.equal(given.applied, "Reverts the sentence.\n\nRefs #483\n", "verbatim, through a file");

  const src = readWorkflow(FIX_WORKFLOW);
  const steps = stepBlocks(src);
  const at = (re) => steps.findIndex((s) => re.test(s));
  assert.ok(at(/name: Refresh the PR body/) < at(/name: Hand the PR to a person/), "the body is fixed before any hand-off comment");
  assert.ok(!allowedTools(src).some((r) => /^Bash\(gh pr edit\b/.test(r)), "Claude itself never holds gh pr edit");
});

test("the fix workflow is valid shell", () => {
  for (const [i, block] of fixBlocks().entries()) {
    const r = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(r.status, 0, `the fix workflow's run block #${i + 1} is not valid shell\n${r.stderr}`);
  }
});

// A workflow edited on a PR branch runs with the repo's secrets on the next push, so only the run
// a person starts (claude.yml) may write one; the unattended fixer hands the diff back instead.
test("only claude.yml asks for workflows: write; the fixer hands a workflow change to a person", () => {
  const perms = (src) => src.match(/additional_permissions: \|\n((?: {12}[\w-]+:[^\n]*\n)+)/)?.[1] ?? "";
  assert.match(perms(readWorkflow(TAG_WORKFLOW)), /^ +workflows: write$/m, `${TAG_WORKFLOW}: no workflows: write`);
  const fix = readWorkflow(FIX_WORKFLOW);
  assert.doesNotMatch(fix, /workflows: write/, "the unattended fixer must not write workflows");

  const handoff = fixBlocks()[2];
  // `head` is the PR head the step re-reads after Claude ran; "abc" is the reviewed one.
  const run = (content, head = "def") => {
    const dir = mkdtempSync(join(tmpdir(), "handoff-"));
    try {
      writeFileSync(join(dir, "gh"), '#!/bin/sh\ncase "$1" in api) [ "$FAKE_HEAD" = fail ] && exit 1; echo "$FAKE_HEAD"; exit 0 ;; esac\ncase "$2" in\n  comment) while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_DIR/comment"; shift; done ;;\n  edit) echo labelled >> "$FAKE_DIR/labels" ;;\nesac\n');
      chmodSync(join(dir, "gh"), 0o755);
      if (content !== undefined) writeFileSync(join(dir, "claude-review-fix-handoff.md"), content);
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail"], {
        input: handoff, encoding: "utf8", cwd: dir,
        env: { PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, TMPDIR: dir, PR: "7", HANDOFF: "claude-review-fix-handoff.md",
          GH_REPO: "o/r", HEAD_SHA: "abc", ROUND: "2", FAKE_HEAD: head, GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "5" },
      });
      const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
      return { status: r.status, log: r.stdout + r.stderr, comment: read("comment"), labels: read("labels") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const pushed = run(undefined);
  assert.ok(pushed.status === 0 && !pushed.comment && !pushed.labels, `a fix was pushed, nothing posted:\n${pushed.log}`);
  // No push → no next review → the budget branch never runs, so the stall is handed off here.
  for (const head of ["abc", "fail"]) {
    const stalled = run(undefined, head);
    assert.equal(stalled.status, 0, stalled.log);
    assert.match(stalled.comment, /^\*\*Not fixed: needs-human — the fixer committed nothing for review round 2/, `head ${head}`);
    assert.ok(stalled.labels, `head ${head}: a stalled PR is labelled needs-human`);
  }
  const given = run("```diff\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n```\n");
  assert.equal(given.status, 0, given.log);
  assert.match(given.comment, /^\*\*Not fixed: needs-human — /);
  assert.match(given.comment, /\.github\/workflows\/ci\.yml/, "the diff is in the comment");
  assert.ok(given.labels, "and the PR is labelled needs-human");
});

// The caller's `on: workflow_run` by name and its `cancel-in-progress: false` are pinned in claude-setup.
test("the fix workflow runs only for claude/ branches, checking out after the author check", () => {
  const src = readWorkflow(FIX_WORKFLOW);
  assert.match(src, /workflow_run\.path == '\.github\/workflows\/claude-code-review\.yml'/, "the review's path is pinned");
  assert.match(src, /startsWith\(github\.event\.workflow_run\.head_branch, 'claude\/'\)/, "claude/ branches only");
  const steps = stepBlocks(src);
  const at = (re) => steps.findIndex((s) => re.test(s));
  assert.ok(at(/id: round/) < at(/actions\/checkout/), "the PR head is checked out only after the round step vets it");
  for (const s of steps.filter((s) => /actions\/checkout|claude-code-action/.test(s))) {
    assert.match(s, /if: steps\.round\.outputs\.fix == 'yes'/, "checkout and Claude run only when the round step says fix");
  }
  assert.match(src, /CLAUDE_BRANCH: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/, "commits land on the PR's branch");
  assert.match(src, /use_commit_signing: true/, "commits go through the file_ops tool, as the App");
  assert.doesNotMatch(src, /\$\{\{[^}]*\bbody\b[^}]*\}\}/, "the review body never reaches the prompt through an expression");
});

test("the fix workflow's allowlist reaches this PR only", () => {
  const rules = allowedTools(readWorkflow(FIX_WORKFLOW));
  assert.ok(rules.includes("mcp__github_file_ops__commit_files"), "agent mode adds no commit tool by itself");
  for (const rule of rules.filter((r) => r.includes("*"))) {
    assert.ok(!grantsUnreviewedProgram(rule) && !wildcardBeforeSubcommand(rule), `${rule} is not a bounded grant`);
  }
  for (const banned of [/^Bash\(gh api\b/, /^Bash\(gh pr (create|edit|merge)\b/, /^Bash\(git (push|commit)\b/]) {
    assert.ok(!rules.some((r) => banned.test(r)), `the fixer must not hold ${banned}`);
  }
});

test("the fix workflow's round step end to end against a fake gh", () => {
  const script = fixScript();
  const STARTED = "2026-10-12T10:00:00Z";
  const fakeGh = [
    "#!/bin/sh",
    'case "$1" in',
    "  api)",
    '    shift; jq=""; url=""',
    '    while [ $# -gt 0 ]; do case "$1" in --paginate) ;; --jq) jq=$2; shift ;; *) url=$1 ;; esac; shift; done',
    '    case "$url" in *comments*) f="$FAKE_DIR/comments" ;; *) f="$FAKE_DIR/pr" ;; esac',
    '    if [ -n "$jq" ]; then exec jq -r "$jq" "$f"; else cat "$f"; fi ;;',
    "  pr)",
    '    case "$2" in',
    '      comment) while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_DIR/comment"; shift; done ;;',
    '      edit) echo labelled >> "$FAKE_DIR/labels" ;;',
    "    esac ;;",
    "esac",
  ].join("\n");
  const run = ({ author = "claude[bot]", state = "open", head = "abc", status }) => {
    const dir = mkdtempSync(join(tmpdir(), "fix-"));
    try {
      writeFileSync(join(dir, "gh"), fakeGh);
      chmodSync(join(dir, "gh"), 0o755);
      writeFileSync(join(dir, "pr"), JSON.stringify({ state, head: { sha: head }, user: { login: author } }));
      const body = `Claude finished [View job](https://github.com/o/r/actions/runs/99)\n\n${status}\n\n` +
        "```\nRound 1 of 3 · VERDICT: CLEAN\n```\n\n- [x] review\n\nVERDICT: x";
      writeFileSync(join(dir, "comments"), JSON.stringify([
        { id: 1, user: { login: "claude[bot]" }, created_at: "2026-10-12T10:00:05Z", html_url: "https://x/c1", body },
      ]));
      const out = join(dir, "out");
      writeFileSync(out, "");
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail"], {
        input: script, encoding: "utf8", cwd: dir,
        env: { PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, TMPDIR: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: out,
          GH_TOKEN: "x", GH_REPO: "o/r", PR: "7", HEAD_SHA: "abc", RUN_ID: "99", RUN_STARTED_AT: STARTED },
      });
      const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
      return { status: r.status, log: r.stdout + r.stderr, output: read("out"), comment: read("comment"),
        labels: read("labels"), review: read("review-round.md") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const fix = run({ status: "Round 2 of 3 · VERDICT: BLOCKING 2" });
  assert.equal(fix.status, 0, fix.log);
  assert.equal(fix.output, "fix=yes\nn=2\nbudget=3\nblocking=2\n", `a blocking round under budget is fixed:\n${fix.log}`);
  assert.match(fix.review, /BLOCKING 2/, "the review body is handed to Claude as a file");
  assert.ok(!fix.comment && !fix.labels, "a fix round posts nothing itself");

  const human = run({ author: "someone", status: "Round 1 of 3 · VERDICT: BLOCKING 1" });
  assert.ok(human.status === 0 && !human.output && !human.comment, `a person's PR is never touched:\n${human.log}`);
  const stale = run({ head: "def", status: "Round 1 of 3 · VERDICT: BLOCKING 1" });
  assert.ok(stale.status === 0 && !stale.output, "a moved head waits for its own review");
  const clean = run({ status: "Round 2 of 3 · VERDICT: CLEAN" });
  assert.ok(clean.status === 0 && !clean.output && !clean.comment, "a clean round needs no fix");

  const spent = run({ status: "Round 3 of 3 · VERDICT: BLOCKING 1" });
  assert.equal(spent.status, 0, spent.log);
  assert.ok(!spent.output && spent.labels, "at the budget the PR is labelled, not fixed");
  assert.match(spent.comment, /^\*\*Not fixed: budget spent — round 3 of 3 still has 1 blocking finding\(s\)\.\*\*/);
  assert.match(spent.comment, /https:\/\/x\/c1/, "the comment links the last review");

  const none = run({ status: "no status line here" });
  assert.ok(none.status === 0 && !none.output && /::warning::/.test(none.log), "no status line: warn, do nothing");
});

// The one job that runs `npm test`, with nothing installed first.
test("ci.yml runs npm test before anything is installed", () => {
  const src = readWorkflow(".github/workflows/ci.yml");
  assert.match(src, /run: npm test/);
  assert.doesNotMatch(src, /npm (ci|install)/, "a step installs packages, so the no-node_modules proof is gone");
});
