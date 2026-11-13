// The release check: a PR that breaks installed callers must say so with `!`, or the release that
// follows its merge moves the floating major under every caller. The interface comparison runs
// over fixtures; the script runs against throwaway git repos; the title rule is held to the one
// release-version.sh bumps a major on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breakingChanges, marksBreaking, workflowInterface } from "../scripts/workflow-interface.mjs";
import { REPO_DIR, repoFile, test } from "./helpers.mjs";

console.log();
console.log("release check");

// A reusable workflow in this repo's shape, from its parts.
const wf = ({ inputs = "", secrets = "", perms = "      contents: read\n" } = {}) =>
  "name: X\non:\n  workflow_call:\n" +
  (inputs && `    inputs:\n${inputs}`) +
  (secrets && `    secrets:\n${secrets}`) +
  `jobs:\n  j:\n    runs-on: ubuntu-latest\n    permissions:\n${perms}    steps:\n      - run: true\n`;
const input = (name, attrs = "        type: string\n") => `      ${name}:\n${attrs}`;

test("the interface is read from this repo's own workflows", () => {
  const review = workflowInterface(repoFile(".github/workflows/review.yml"));
  assert.deepEqual(review.inputs, { "round-budget": { required: false, type: "string" } });
  assert.deepEqual(review.secrets, { CLAUDE_CODE_OAUTH_TOKEN: { required: true, type: "" } });
  for (const f of ["tag.yml", "review.yml", "review-fix.yml", "auto-merge.yml"]) {
    assert.deepEqual(workflowInterface(repoFile(`.github/workflows/${f}`)).unread, [], `${f}: every block is one the check reads`);
  }
  assert.equal(review.permissions["actions"], "read");
  assert.equal(review.permissions["id-token"], "write");
  assert.equal(review.permissions["contents"], "read", "a comment between entries is skipped");
});

test("what breaks a caller written for the old interface", () => {
  const base = wf({ inputs: input("budget"), secrets: "      TOKEN:\n        required: true\n" });
  const same = (after) => breakingChanges({ "a.yml": base }, { "a.yml": after });
  assert.deepEqual(same(base), [], "no change, nothing breaks");
  assert.match(breakingChanges({ "a.yml": base }, {}).join(), /a\.yml is gone or renamed/);
  assert.match(same(wf({ secrets: "      TOKEN:\n        required: true\n" })).join(), /input `budget` is gone/);
  assert.match(same(wf({ inputs: input("budget") + input("mode", "        required: true\n"), secrets: "      TOKEN:\n        required: true\n" })).join(),
    /input `mode` is now required/);
  assert.match(same(wf({ inputs: input("budget") })).join(), /secret `TOKEN` is gone/);
  assert.match(same(wf({ inputs: input("budget"), secrets: "      TOKEN:\n        required: true\n", perms: "      contents: write\n" })).join(),
    /now needs `contents: write` \(was read\)/);
  assert.match(same(wf({ inputs: input("budget"), secrets: "      TOKEN:\n        required: true\n", perms: "      contents: read\n      checks: read\n" })).join(),
    /now needs `checks: read` \(was none\)/);
  assert.match(same(wf({ inputs: input("budget", "        type: number\n"), secrets: "      TOKEN:\n        required: true\n" })).join(),
    /input `budget` changed type \(string → number\)/, "a caller passing `${{ vars.X }}`, a string, fails a number input");
  // Forms the parser does not read fail closed rather than passing as "nothing needed".
  const asIs = wf({ inputs: input("budget"), secrets: "      TOKEN:\n        required: true\n" });
  for (const form of ["permissions: write-all", "permissions: { contents: write }"]) {
    const after = asIs.replace("    permissions:\n      contents: read\n", `    ${form}\n`);
    assert.notEqual(after, asIs, "the fixture changed shape — this test rewrites it");
    assert.match(same(after).join(), new RegExp(`\`${form.replace(/[{}]/g, "\\$&")}\` is not one entry per line`), form);
  }
});

test("what a caller written for the old interface still runs against", () => {
  const base = wf({ inputs: input("budget"), perms: "      contents: write\n      checks: read\n" });
  const same = (after) => breakingChanges({ "a.yml": base }, { "a.yml": after });
  assert.deepEqual(same(wf({ inputs: input("budget") + input("extra", "        default: \"\"\n"), perms: "      contents: write\n      checks: read\n" })), [],
    "a new optional input");
  assert.deepEqual(same(wf({ inputs: input("budget"), perms: "      contents: read\n" })), [], "a permission lowered or dropped");
  assert.deepEqual(breakingChanges({}, { "new.yml": base }), [], "a new workflow");
});

test("the title rule is the one the release bumps a major on", () => {
  for (const t of ["feat!: rename", "fix(review)!: drop input", "refactor!: x"]) assert.ok(marksBreaking(t), t);
  for (const t of ["feat: x", "fix: handle feat!: in text", "feat(x): y", "Feat!: capital"]) assert.ok(!marksBreaking(t), t);
  // release-version.sh's grep, applied to the same subjects.
  const grep = repoFile("scripts/release-version.sh").match(/grep -Eq '(\^\[a-z\]\+[^']*!:)'/)?.[1];
  assert.ok(grep, "release-version.sh's major pattern changed spelling — this test reads it");
  const re = new RegExp(grep);
  for (const t of ["feat!: rename", "fix(review)!: drop input", "feat: x", "fix: handle feat!: in text", "Feat!: capital"]) {
    assert.equal(re.test(t), marksBreaking(t), `release-version.sh and the check disagree on "${t}"`);
  }
});

// The script end to end: a repo whose release tag holds one workflow, then a change on top.
test("the check fails a breaking change under a patch title, and only that", () => {
  const run = (after, title) => {
    const dir = mkdtempSync(join(tmpdir(), "breaking-"));
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (...args) => assert.equal(spawnSync("git", args, { cwd: dir, env }).status, 0, `git ${args.join(" ")}`);
    try {
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, ".github/workflows/a.yml"), wf());
      git("init", "-q");
      git("add", ".");
      git("commit", "-q", "-m", "chore: init");
      git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
      if (after === null) rmSync(join(dir, ".github/workflows/a.yml"));
      else writeFileSync(join(dir, ".github/workflows/a.yml"), after);
      const r = spawnSync("node", [join(REPO_DIR, "scripts/breaking-changes.mjs")], {
        cwd: dir, env: title === undefined ? env : { ...env, PR_TITLE: title }, encoding: "utf8" });
      return { status: r.status, log: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const widened = wf({ perms: "      contents: write\n" });
  const patch = run(widened, "fix: needs write now");
  assert.equal(patch.status, 1, patch.log);
  assert.match(patch.log, /^::error::This PR breaks callers written for v1\.0\.0/m);
  assert.match(patch.log, /now needs `contents: write`/);
  assert.doesNotMatch(patch.log, /needs write now/, "the PR-controlled title never reaches the log");
  assert.equal(run(widened, "feat!: needs write now").status, 0, "a marked title passes");
  assert.equal(run(null, "chore: drop it").status, 1, "a removed workflow under a patch title fails");
  assert.equal(run(wf(), "fix: nothing").status, 0, "an unchanged interface passes any title");
  assert.equal(run(widened, undefined).status, 0, "run by hand, it only lists");
});

test("the release check runs on every PR change, the title included", () => {
  const src = repoFile(".github/workflows/release-check.yml");
  assert.match(src, /^ {4}types: \[opened, synchronize, reopened, edited\]$/m, "`edited` re-runs it after a title fix");
  assert.match(src, /^permissions:\n {2}contents: read\n/m, "it reads, nothing more");
  assert.match(src, /fetch-depth: 0/, "the release tag is needed to compare against");
  assert.match(src, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}\n\s*run: node scripts\/breaking-changes\.mjs/,
    "the title reaches the script through env, never the shell");
});
