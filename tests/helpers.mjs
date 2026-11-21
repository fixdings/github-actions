// Shared by every tests/*.test.mjs file: the tiny assert-and-count runner, and the repo
// root path (tests/ sits at the root, so REPO_DIR is one level up from here). Zero
// dependencies: the suite runs on a checkout with no node_modules.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


// Private to this module: only summary() reads them, so exporting them as live bindings
// invited a caller to depend on a counter mid-run.
let passed = 0;
let failed = 0;

// An async test's result is not known when `fn()` returns — only that it STARTED. Judging it
// there printed ✓ and counted a pass for a test that had not run, and a later rejection escaped
// the try/catch entirely: Node killed the process with an uncaught exception at whatever point
// the rejection surfaced, so a red run reported "0 failed" and the crash landed against an
// arbitrary file. Async
// results are collected here and awaited by `settle()` before any summary is printed.
const pending = [];

export function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(
        () => { console.log(`  ✓ ${name}`); passed++; },
        (e) => {
          console.log(`  ✗ ${name}`);
          console.log(`    ${e && e.message ? e.message : e}`);
          failed++;
          process.exitCode = 1;
        },
      ));
      return;
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
    // Set here, not only in all.mjs: a topic file run on its own (`node tests/callers.test.mjs`)
    // never reaches a summary, so without this it printed ✗ and exited 0 — a red file reading
    // green to anything checking the status. Running one file is what the review's grant
    // `Bash(node tests/*)` (review.yml) is for, so that path has to fail properly too.
    process.exitCode = 1;
  }
}

// `loadFailures` is counted separately because a file that throws at import never registers
// a test — reporting "0 failed" next to a file that never ran is how a red build reads green.
/**
 * Wait for every async test started so far, so counts are final before they are reported.
 *
 * `all.mjs` must await this before `summary()`. A single topic file run on its own needs no call:
 * its pending promises keep the event loop alive, so their handlers run — and set `exitCode` —
 * before the process can exit.
 */
export async function settle() {
  await Promise.all(pending.splice(0));
}

export function summary(loadFailures = 0) {
  console.log();
  const unloaded = loadFailures ? ` · ${loadFailures} file(s) failed to load` : "";
  console.log(`${passed} passed · ${failed} failed${unloaded}`);
  return { passed, failed, loadFailures, ok: failed === 0 && loadFailures === 0 };
}

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const repoFile = (rel) => readFileSync(join(REPO_DIR, rel), "utf8");

// workflows.test.mjs hand-types the `--allowedTools` rules, and this is the one canonical form
// they must keep: a rule that already contains a `*` may not spell its tail with the `:*`
// shorthand. A literal-string assertion cannot see this — it proves a rule is PRESENT, never that
// it reaches a command.
export const shorthandAfterGlob = (rule) => rule.endsWith(":*)") && rule.indexOf("*") < rule.length - 2;
