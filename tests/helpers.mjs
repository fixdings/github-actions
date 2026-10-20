// Shared by every tests/*.test.mjs file: the tiny assert-and-count runner, and the repo
// root path (tests/ sits at the root, so REPO_DIR is one level up from here). Zero
// dependencies: the suite runs on a checkout with no node_modules.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


// Private to this module: only summary() reads them, so exporting them as live bindings
// invited a caller to depend on a counter mid-run.
let passed = 0;
let failed = 0;
let skipped = 0;

// An async test's result is not known when `fn()` returns — only that it STARTED. Judging it
// there printed ✓ and counted a pass for a test that had not run, and a later rejection escaped
// the try/catch entirely: Node killed the process with an uncaught exception at whatever point
// the rejection surfaced, so a red run reported "0 failed" and the crash landed against an
// arbitrary file. That is the whole of the `apply.test.mjs` "flake". Async results are collected
// here and awaited by `settle()` before any summary is printed.
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
    // Set here, not only in all.mjs: a topic file run on its own (`node tests/rm-guard.test.mjs`)
    // never reaches a summary, so without this it printed ✗ and exited 0 — a red file reading
    // green to anything checking the status. Running one file is the whole reason the CI grant
    // is `Bash(node tests/*)`, so that path has to fail properly too.
    process.exitCode = 1;
  }
}

/**
 * A test deliberately not run, because it asserts something that is KNOWN BROKEN and tracked.
 *
 * It prints, loudly and every run, rather than disappearing — a silently removed test is
 * indistinguishable from a defect that went away, and this exists precisely for defects that did
 * not. `reason` must name the issue, so the line itself says where to read what is wrong and what
 * removing the skip would prove.
 *
 * Not counted as passed: the summary would then claim coverage the run did not have.
 */
export function skip(name, _fn, reason = "") {
  skipped++;
  console.log(`  ⊘ ${name}${reason ? ` — ${reason}` : ""}`);
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
  // Skips are reported in the headline, never folded into "passed": a run that skipped a known
  // defect is not the same as one that proved it fixed.
  const skips = skipped ? ` · ${skipped} skipped` : "";
  console.log(`${passed} passed · ${failed} failed${skips}${unloaded}`);
  return { passed, failed, loadFailures, ok: failed === 0 && loadFailures === 0 };
}

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const repoFile = (rel) => readFileSync(join(REPO_DIR, rel), "utf8");

// The other half of a cross-repo contract (the spec-workflow plugin's `watch-pr`) lives in
// fixdings/spec-workflow: `$SPEC_WORKFLOW_DIR`, else a sibling `../spec-workflow` checkout.
// Without it the test is SKIPPED, never passed — a contract with one side missing proves nothing.
const SPEC_WORKFLOW_ENV = "SPEC_WORKFLOW_DIR";
export const SPEC_WORKFLOW_DIR = resolve(REPO_DIR, process.env[SPEC_WORKFLOW_ENV] || "../spec-workflow");
export const specWorkflowFile = (rel) => readFileSync(join(SPEC_WORKFLOW_DIR, rel), "utf8");
export const crossRepo = (name, fn) =>
  existsSync(SPEC_WORKFLOW_DIR) ? test(name, fn) : skip(name, fn, `no spec-workflow checkout at ${SPEC_WORKFLOW_DIR} (set ${SPEC_WORKFLOW_ENV})`);

// workflows.test.mjs hand-types the `--allowedTools` rules, and this is the one canonical form
// they must keep: a rule that already contains a `*` may not spell its tail with the `:*`
// shorthand. A literal-string assertion cannot see this — it proves a rule is PRESENT, never that
// it reaches a command.
export const shorthandAfterGlob = (rule) => rule.endsWith(":*)") && rule.indexOf("*") < rule.length - 2;
