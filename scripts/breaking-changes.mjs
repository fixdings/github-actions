#!/usr/bin/env node
// Fails a PR that breaks installed callers without saying so. Every merge that changes
// something a caller runs releases, and only a `!` in the title makes that release a new major — so a removed workflow, a new required input
// or secret, or a new job permission under a patch title would move the floating major under
// every installed caller and fail their runs before they start. Compares the reusable workflows
// at the last release tag with HEAD. Run by .github/workflows/release-check.yml with PR_TITLE;
// run locally without it, it only lists what it finds.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { breakingChanges, isReusable, marksBreaking } from "./workflow-interface.mjs";

const DIR = ".github/workflows";
const CALLERS_DIR = "callers";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const base = git("tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname").split("\n")[0];
if (!base) {
  console.log("No release tag yet: nothing to compare against.");
  process.exit(0);
}

const title = process.env.PR_TITLE;
let failed = false;

// The callers must pin the major this PR releases. release-version.sh bumps the major once when
// ANY subject since the base tag has a `!`, so that is a `!` already merged into main and not yet
// released (`--first-parent`: in CI, HEAD is the PR's merge commit, whose first parent is main, so
// the PR branch's own commit subjects stay out) or this PR's title. A `!` that leaves the pins
// behind publishes v<N+1> callers still calling @v<N>; a pin ahead calls a tag that never comes.
const PIN = /^\s*uses:\s*["']?[^\s"'#]+\/\.github\/workflows\/[\w.-]+@([\w.-]+)["']?\s*(?:#.*)?$/gm;
const pins = existsSync(CALLERS_DIR)
  ? readdirSync(CALLERS_DIR)
    .filter((f) => /^[\w.-]+\.ya?ml$/.test(f))
    .flatMap((f) => [...readFileSync(join(CALLERS_DIR, f), "utf8").matchAll(PIN)].map((m) => ({ file: `${CALLERS_DIR}/${f}`, pin: m[1] })))
  : [];
const pending = git("log", "--first-parent", "--format=%s", `${base}..HEAD`).split("\n").some(marksBreaking);
if (title === undefined) {
  if (pins.length) console.log(`The callers pin ${[...new Set(pins.map((p) => `@${p.pin}`))].join(", ")}${pending ? `; a major is pending since ${base}` : ""}.`);
} else {
  const major = Number(base.match(/^v(\d+)/)[1]) + (pending || marksBreaking(title) ? 1 : 0);
  const off = pins.filter((p) => p.pin !== `v${major}`);
  if (off.length) {
    console.log(`::error::This PR releases v${major}, so every caller in ${CALLERS_DIR}/ must pin @v${major}.`);
    console.log(off.map((p) => `  - ${p.file} pins @${p.pin}`).join("\n"));
    failed = true;
  }
}

// The reusable workflows among `names`, read by `read`. Names are filtered to plain file names:
// they reach the log.
const reusable = (names, read) =>
  Object.fromEntries(
    names
      .filter((f) => /^[\w.-]+\.ya?ml$/.test(f))
      .map((f) => [f, read(f)])
      .filter(([, src]) => isReusable(src)),
  );
const atBase = reusable(git("ls-tree", "--name-only", `${base}:${DIR}`).split("\n"), (f) => git("show", `${base}:${DIR}/${f}`));
// The working tree, not HEAD: in CI they are the same commit, and locally it covers what is not
// committed yet.
const now = reusable(readdirSync(DIR), (f) => readFileSync(join(DIR, f), "utf8"));

// Both checks report before the exit, so one run shows every problem.
const changes = breakingChanges(atBase, now);
const list = changes.map((c) => `  - ${c}`).join("\n");
if (!changes.length) {
  console.log(`Nothing here breaks a caller written for ${base}.`);
} else if (title === undefined) {
  console.log(`Breaks callers written for ${base}:\n${list}`);
} else if (marksBreaking(title)) {
  console.log(`Breaks callers written for ${base}, and the title marks it (\`!\`), so it releases a new major:\n${list}`);
} else {
  // The title is PR-controlled, so it is never echoed into the log.
  console.log(`::error::This PR breaks callers written for ${base}, but its title has no \`!\`, so it would release as a minor or patch under every installed caller. Mark the title (\`feat!: …\`) and move the callers in callers/, or keep the old interface.`);
  console.log(list);
  failed = true;
}
process.exit(failed ? 1 : 0);
