// The caller workflows a repo installs, listed in callers/manifest.json and fetched from here by
// fixdings/claude-setup: the three this repo runs itself, in .github/workflows/, and the opt-in
// gate it does not, in callers/. Each calls a reusable workflow of this repo, so the two halves
// must agree on what crosses between them — the file, the inputs, the secret, and above all the
// permissions, since a called job can only narrow its caller's and a missing one fails every
// run before it starts. ONE copy of each: this repo's own callers are the installed files.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { workflowInterface } from "../scripts/workflow-interface.mjs";
import { REPO_DIR, repoFile, test } from "./helpers.mjs";

console.log();
console.log("callers");

const CALLERS_DIR = "callers/";
const WORKFLOWS_DIR = ".github/workflows/";
const REMOTE = "fixdings/github-actions/.github/workflows/";
const manifest = JSON.parse(repoFile(`${CALLERS_DIR}manifest.json`));
// By installed name: each is installed as .github/workflows/<its file name>.
const SOURCE = Object.fromEntries(manifest.callers.map((c) => [basename(c.source), c.source]));
const CALLERS = Object.keys(SOURCE).sort();
const caller = (f) => repoFile(SOURCE[f]);
const usesOf = (src) => src.match(/^ {4}uses: (\S+)$/m)?.[1];

// A block of `key: value` lines at `indent`, directly under the `head` line, comments skipped.
const block = (src, head, indent) => {
  const m = src.match(new RegExp(`^${head}\\n((?: {${indent}}.*\\n|\\n)*)`, "m"));
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(new RegExp(`^ {${indent}}([\\w-]+):(.*)$`));
    if (kv) out[kv[1]] = kv[2].replace(/#.*$/, "").trim();
  }
  return out;
};
const LEVEL = { none: 0, read: 1, write: 2 };

// Every file that calls this repo's workflows at a release is a caller to install, and the
// manifest names each one once: a caller added without it would never reach a repo.
test("the manifest lists exactly the caller files, each once, with a known group", () => {
  assert.equal(CALLERS.length, manifest.callers.length, "two callers would install under one name");
  const remoteCallers = [
    ...readdirSync(join(REPO_DIR, WORKFLOWS_DIR)).map((f) => WORKFLOWS_DIR + f),
    ...readdirSync(join(REPO_DIR, CALLERS_DIR)).map((f) => CALLERS_DIR + f),
  ].filter((p) => p.endsWith(".yml") && usesOf(repoFile(p))?.startsWith(REMOTE));
  assert.deepEqual(remoteCallers.sort(), manifest.callers.map((c) => c.source).sort(),
    "every file calling fixdings/github-actions at a release must be in callers/manifest.json, and nothing else");
  for (const c of manifest.callers) assert.ok(["claude", "auto-merge"].includes(c.group), `${c.source}: group ${c.group}`);
});

test("every caller calls a reusable workflow of this repo, all at one floating major", () => {
  const majors = new Set();
  for (const f of CALLERS) {
    const uses = usesOf(caller(f));
    const m = uses?.match(new RegExp(`^${REMOTE.replace(/[./]/g, "\\$&")}([\\w-]+\\.yml)@(v\\d+)$`));
    assert.ok(m, `${f}: uses ${uses} — expected ${REMOTE}<file>.yml@v<major>`);
    majors.add(m[2]);
    const target = WORKFLOWS_DIR + m[1];
    assert.ok(existsSync(join(REPO_DIR, target)), `${f}: ${target} does not exist`);
    assert.match(repoFile(target), /^ {2}workflow_call:$/m, `${f}: ${target} is not a reusable workflow`);
  }
  assert.equal(majors.size, 1, `the callers pin different majors: ${[...majors]}`);
});

test("every caller grants each permission its reusable job asks for", () => {
  for (const f of CALLERS) {
    const src = caller(f);
    const granted = block(src, " {4}permissions:", 6);
    assert.ok(granted, `${f}: no job permissions block`);
    const target = repoFile(WORKFLOWS_DIR + usesOf(src).split("/").pop().split("@")[0]);
    const asked = block(target, " {4}permissions:", 6);
    assert.ok(asked, `${f}: the reusable job declares no permissions`);
    for (const [scope, level] of Object.entries(asked)) {
      assert.ok((LEVEL[granted[scope]] ?? 0) >= LEVEL[level],
        `${f}: the reusable job asks for ${scope}: ${level}, the caller grants ${granted[scope] ?? "nothing"} — every run would fail before it starts`);
    }
  }
});

test("every caller passes exactly the reusable workflow's secrets by name, and only its inputs", () => {
  const used = new Set();
  for (const f of CALLERS) {
    const src = caller(f);
    assert.doesNotMatch(src, /secrets: inherit/, `${f}: inherit does not cross owners`);
    const target = repoFile(WORKFLOWS_DIR + usesOf(src).split("/").pop().split("@")[0]);
    const wants = Object.keys(block(target, " {4}secrets:", 6) ?? {});
    const passes = block(src, " {4}secrets:", 6) ?? {};
    assert.deepEqual(Object.keys(passes).sort(), wants.sort(), `${f}: secrets passed vs declared`);
    for (const [name, value] of Object.entries(passes)) {
      assert.equal(value, `\${{ secrets.${name} }}`, `${f}: ${name} is handed over by name`);
      used.add(name);
    }
    const inputs = Object.keys(block(target, " {4}inputs:", 6) ?? {});
    for (const key of Object.keys(block(src, " {4}with:", 6) ?? {})) {
      assert.ok(inputs.includes(key), `${f}: with ${key}, which the reusable workflow does not declare`);
    }
  }
  assert.deepEqual([...used].sort(), [...manifest.secrets].sort(), "manifest.json secrets are the ones the callers pass");
});

test("each caller's manifest entry names the repo variables it reads", () => {
  for (const c of manifest.callers) {
    const vars = [...repoFile(c.source).matchAll(/\$\{\{\s*vars\.(\w+)\s*\}\}/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(vars)].sort(), [...c.vars].sort(), `${c.source}: vars`);
  }
});

// This repo runs every caller but the gate, from the released workflows — the files it ships, so
// there is no second copy to keep in step. The gate must not run here: nothing merges itself.
test("this repo runs the claude group from .github/workflows/, and the gate is kept out of it", () => {
  for (const c of manifest.callers) {
    const dir = c.group === "claude" ? WORKFLOWS_DIR : CALLERS_DIR;
    assert.equal(c.source, dir + basename(c.source), `${c.source}: a ${c.group} caller lives in ${dir}`);
  }
  assert.ok(!existsSync(join(REPO_DIR, WORKFLOWS_DIR, "claude-auto-merge.yml")), "the gate would merge this repo's own PRs");
});

// Ported from claude-setup, which installs these files: the shape each caller owns.
const collapsed = (s) => s.replace(/\s+/g, " ");
const concurrencyBlock = (src) => {
  const m = src.match(/^concurrency:\n(?: .*\n|\n)*/m);
  assert.ok(m, "no workflow-level concurrency block");
  return m[0];
};
const triggers = (src) => {
  const on = src.match(/^on:\n(?: .*\n|\n)*/m);
  assert.ok(on, "no trigger block");
  return [...on[0].matchAll(/^ {2}(\w+):$/gm)].map((m) => m[1]);
};

// A workflow-level group is taken when the run is CREATED, before the called job's `if` runs, so
// a run the `if` will reject still occupies the group — and a group holds only ONE pending run,
// so a third arrival cancels the queued one. Measured: the action's own tracking comment (actor
// claude[bot]) queued into the real run's group and was cancelled. Routing it to a per-run group
// is what keeps it from evicting real work.
test("the tag caller keeps non-working runs out of the shared concurrency group", () => {
  const group = collapsed(concurrencyBlock(caller("claude.yml")));
  // Every run the tag workflow's job `if` rejects goes to the no-op group: the exact negation of
  // that `if`, so a comment without "@claude" cannot take the one pending slot either.
  const jobIf = collapsed(repoFile(WORKFLOWS_DIR + "tag.yml").match(/^ {4}if: \|\n((?: {6}.*\n)+)/m)[1]).trim();
  assert.equal(jobIf, "github.actor != 'claude[bot]' && contains(github.event.comment.body, '@claude')",
    "tag.yml's job if changed — the no-op group below must stay its negation");
  assert.match(group, /\$\{\{ \(github\.actor == 'claude\[bot\]' \|\| !contains\(github\.event\.comment\.body, '@claude'\)\) && format\('claude-noop-/,
    "every run the job `if` rejects must stay out of the shared group");
  assert.match(group, /format\('claude-noop-\{0\}', github\.run_id\)/,
    "the escape group must be unique per run, or the phantoms just contend with each other");
  assert.match(group, /format\('claude-\{0\}', github\.event\.issue\.number \|\| github\.event\.pull_request\.number\)/,
    "real runs must still share one group per issue/PR");
  assert.match(group, /cancel-in-progress: false/, "this job commits — never kill it mid-write");
});

// Typing "@claude" in a comment is meant to be the ONLY way in. A label trigger fans out
// (1 + N webhooks for an N-label issue) and `pull_request_review` fires on a review body
// nobody thinks of as a message to Claude, so both were dropped; this keeps them dropped.
test("the tag caller starts only from a comment", () => {
  assert.deepEqual(triggers(caller("claude.yml")), ["issue_comment", "pull_request_review_comment"]);
});

test("the review caller runs on its PR's pushes, a newer push cancelling the older run", () => {
  const src = caller("claude-code-review.yml");
  assert.deepEqual(triggers(src), ["pull_request"]);
  assert.match(concurrencyBlock(src), /cancel-in-progress: true/);
});

// `workflow_run` runs the DEFAULT branch's copy, so the PR under review cannot rewrite the gate
// or its own fixer. Both match the review by NAME here; the path pin is in the called job's `if`.
test("the gate and the fixer callers run on workflow_run of the review, by its name", () => {
  const reviewName = caller("claude-code-review.yml").match(/^name: (.*)$/m)[1];
  for (const [f, cancel] of [["claude-auto-merge.yml", "true"], ["claude-review-fix.yml", "false"]]) {
    const src = caller(f);
    assert.deepEqual(triggers(src), ["workflow_run"], `${f}: only workflow_run runs the default branch's copy`);
    assert.equal(src.match(/workflows: \[(.*)\]/)[1], reviewName, `${f}: workflow_run matches the review workflow by name`);
    assert.match(concurrencyBlock(src), new RegExp(`cancel-in-progress: ${cancel}`), `${f}: cancel-in-progress`);
    // A workflow_run run is recorded against the DEFAULT branch's last commit, so `watch-pr`
    // cannot find it by the PR head sha — it matches the run's title (`displayTitle`) instead.
    const title = src.match(/^run-name: (.*)$/m);
    assert.ok(title, `${f}: no top-level run-name, so its run cannot be matched to a PR head`);
    assert.match(title[1], /\$\{\{ github\.event\.workflow_run\.head_sha \}\}/, `${f}: the run-name must carry the reviewed head sha`);
  }
});

// The gate and the fixer pin the review by this path in their job `if`, so it is an interface.
test("the review caller is installed at the path the gate and the fixer pin", () => {
  for (const wf of ["auto-merge.yml", "review-fix.yml"]) {
    assert.match(repoFile(WORKFLOWS_DIR + wf), /workflow_run\.path == '\.github\/workflows\/claude-code-review\.yml'/, wf);
  }
  assert.ok(CALLERS.includes("claude-code-review.yml"), "installed under its own name, so at .github/workflows/claude-code-review.yml");
});

// A reusable workflow that gains a required input fails every caller not passing it, and the
// README is where an installer reads what each input means.
test("every caller passes each input its workflow requires, and the README documents every input", () => {
  const readme = repoFile("README.md");
  for (const f of CALLERS) {
    const src = caller(f);
    const target = usesOf(src).split("/").pop().split("@")[0];
    const { inputs } = workflowInterface(repoFile(WORKFLOWS_DIR + target));
    const passed = Object.keys(block(src, " {4}with:", 6) ?? {});
    for (const [name, { required }] of Object.entries(inputs)) {
      if (required) assert.ok(passed.includes(name), `${f}: ${target} requires input ${name}, which the caller does not pass`);
      assert.ok(readme.includes(`\`${name}\``), `README.md does not document ${target}'s input \`${name}\``);
    }
  }
});
