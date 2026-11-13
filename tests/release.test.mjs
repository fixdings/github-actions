// The release workflow: every push to main tags the next version, moves the floating major and
// publishes a release. The version is scripts/release-version.sh's, run here against throwaway
// git repos; the workflow around it is checked for the parts that decide what reaches callers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR, repoFile, test } from "./helpers.mjs";

console.log();
console.log("release workflow");

const SCRIPT = join(REPO_DIR, "scripts/release-version.sh");
const WORKFLOW = ".github/workflows/release.yml";

// A repo with the given tag on its first commit (or each of several tags on a commit of its own,
// in order) and these commit messages after it, isolated from the user's git config (signing,
// hooks, templates).
const release = (tags, messages) => {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  const env = {
    PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  try {
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "chore: init");
    for (const [i, tag] of [tags].flat().filter(Boolean).entries()) {
      if (i > 0) git("commit", "-q", "--allow-empty", "-m", `chore: ${tag}`);
      git("tag", "-a", tag, "-m", tag);
    }
    for (const m of messages) git("commit", "-q", "--allow-empty", "-m", m);
    const out = join(dir, "out");
    writeFileSync(out, "");
    const r = spawnSync("bash", [SCRIPT], { cwd: dir, env: { ...env, GITHUB_OUTPUT: out }, encoding: "utf8" });
    const output = Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("=")));
    return { status: r.status, log: r.stdout + r.stderr, ...output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a fix, a docs change or a chore is a patch release", () => {
  for (const m of ["fix: verify step pages all comments (#3)", "docs: README", "chore: sync", "refactor(gate): split"]) {
    const r = release("v1.0.0", [m]);
    assert.equal(r.status, 0, r.log);
    assert.deepEqual([r.version, r.previous, r.major], ["v1.0.1", "v1.0.0", "v1"], m);
  }
});

test("a feat is a minor release, and wins over fixes in the same push", () => {
  assert.equal(release("v1.0.3", ["feat: release workflow (#4)"]).version, "v1.1.0");
  assert.equal(release("v1.0.3", ["feat(review): x"]).version, "v1.1.0", "a scope is still a feat");
  assert.equal(release("v1.0.3", ["fix: a", "feat: b", "docs: c"]).version, "v1.1.0");
});

test("a breaking change is a new major, by `!` or by footer", () => {
  for (const msgs of [["feat!: rename the reusable workflows (#5)"], ["refactor(actions)!: x"],
    ["feat: x\n\nBREAKING CHANGE: callers move to the new file names"], ["fix: a", "feat!: b"]]) {
    const r = release("v1.4.2", msgs);
    assert.deepEqual([r.version, r.major], ["v2.0.0", "v2"], JSON.stringify(msgs));
  }
});

test("a squash body's listed commits and a mid-line `!` are not subjects", () => {
  // GitHub's squash body lists the branch's commits as `* feat: …`.
  assert.equal(release("v1.0.0", ["fix: x (#6)\n\n* feat: first try\n* feat!: second try"]).version, "v1.0.1");
  assert.equal(release("v1.0.0", ["fix: handle feat!: in a message"]).version, "v1.0.1");
});

test("the base is the highest version, not the newest tag or a text sort", () => {
  // v1.10.0, then a later v1.9.4: by date or by text the base would be v1.9.4.
  assert.equal(release(["v1.10.0", "v1.9.4"], ["fix: x"]).version, "v1.10.1");
  // A floating major beside the versions is not a version.
  assert.equal(release(["v1.0.0", "v1"], ["fix: x"]).version, "v1.0.1");
});

test("an already released HEAD releases nothing, and no tag at all is an error", () => {
  const same = release("v1.0.0", []);
  assert.equal(same.status, 0, same.log);
  assert.equal(same.version, undefined, "a re-run on a tagged commit must not tag again");
  const none = release("", ["feat: x"]);
  assert.equal(none.status, 1);
  assert.match(none.log, /::error::No vX\.Y\.Z tag/);
});

test("the release workflow tests, then tags main, moves the major under a lease and writes notes", () => {
  const src = repoFile(WORKFLOW);
  assert.match(src, /^on:\n {2}push:\n {4}branches: \[main\]\n/m, "releases only from main");
  assert.match(src, /^permissions:\n {2}contents: write\n\n/m, "tags and releases, nothing more");
  assert.match(src, /cancel-in-progress: false/, "a release run is never cancelled mid-push");
  assert.match(src, /fetch-depth: 0/, "the bump reads every message since the last tag");
  assert.ok(src.indexOf("run: npm test") !== -1 && src.indexOf("run: npm test") < src.indexOf("run: bash scripts/release-version.sh"),
    "the suite runs before anything is tagged");
  assert.match(src, /if: steps\.next\.outputs\.version != ''/, "nothing is tagged when HEAD is already released");
  assert.match(src, /git push --force-with-lease="refs\/tags\/\$MAJOR:\$old" origin "refs\/tags\/\$MAJOR"/,
    "the floating major moves only from the value just read");
  assert.doesNotMatch(src, /git push (?:-f|--force)(?:\s|$)/, "no plain force push");
  assert.match(src, /gh release create "\$VERSION" --verify-tag/, "the release is for the tag just pushed");
  assert.match(src, /--generate-notes --notes-start-tag "\$PREVIOUS"/, "notes cover the PRs since the previous version");
  const block = src.match(/run: \|\n((?: {10}.*\n| *\n)*)/)[1].replace(/^ {10}/gm, "");
  const r = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
  assert.equal(r.status, 0, `the release step is not valid shell\n${r.stderr}`);
});
