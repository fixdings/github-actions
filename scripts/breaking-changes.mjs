#!/usr/bin/env node
// Fails a PR that breaks installed callers without saying so. Every merge releases, and only a
// `!` in the title makes that release a new major — so a removed workflow, a new required input
// or secret, or a new job permission under a patch title would move the floating major under
// every installed caller and fail their runs before they start. Compares the reusable workflows
// at the last release tag with HEAD. Run by .github/workflows/release-check.yml with PR_TITLE;
// run locally without it, it only lists what it finds.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { breakingChanges, isReusable, marksBreaking } from "./workflow-interface.mjs";

const DIR = ".github/workflows";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const base = git("tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname").split("\n")[0];
if (!base) {
  console.log("No release tag yet: nothing to compare against.");
  process.exit(0);
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

const changes = breakingChanges(atBase, now);
if (!changes.length) {
  console.log(`Nothing here breaks a caller written for ${base}.`);
  process.exit(0);
}
const list = changes.map((c) => `  - ${c}`).join("\n");
const title = process.env.PR_TITLE;
if (title === undefined) {
  console.log(`Breaks callers written for ${base}:\n${list}`);
} else if (marksBreaking(title)) {
  console.log(`Breaks callers written for ${base}, and the title marks it (\`!\`), so it releases a new major:\n${list}`);
} else {
  // The title is PR-controlled, so it is never echoed into the log.
  console.log(`::error::This PR breaks callers written for ${base}, but its title has no \`!\`, so it would release as a minor or patch under every installed caller. Mark the title (\`feat!: …\`) and move the callers in callers/, or keep the old interface.`);
  console.log(list);
  process.exit(1);
}
