#!/usr/bin/env node
// Single entry point for the whole suite, run via `node tests/all.mjs` (or `npm test`). It
// imports every top-level `*.test.mjs` here; discovery is not recursive.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settle, summary } from "./helpers.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".test.mjs")).sort();

// Tests run at import time, so a file that throws OUTSIDE a test() would take the whole run
// down before the summary. Catch it, name it, and let the rest run; the count still fails.
let loadFailures = 0;
for (const file of files) {
  try {
    await import(join(DIR, file));
  } catch (e) {
    loadFailures++;
    console.log(`\n  ✗ ${file} failed to load`);
    console.log(`    ${e.message}`);
  }
}

// Async tests finish after their file's import resolves, so their pass/fail is not final
// until they settle.
await settle();

process.exit(summary(loadFailures).ok ? 0 : 1);
