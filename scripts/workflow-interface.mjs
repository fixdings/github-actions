// What a reusable workflow offers its callers: the inputs and secrets it declares under
// `on.workflow_call`, and the job permissions it needs. Read by tests/callers.test.mjs and by
// scripts/breaking-changes.mjs. It parses the shapes this repo's workflow files use — two-space
// YAML, one `key: value` per line — not YAML at large.

const LEVEL = { none: 0, read: 1, write: 2 };

export const isReusable = (src) => /^ {2}workflow_call:$/m.test(src);

// Every block opened by a line matching `head`: its entries one indent deeper, each with the
// `key: value` attributes one indent deeper still. Comments and blank lines are skipped.
function blocks(src, head) {
  const lines = src.split("\n");
  const out = [];
  for (const [start, line] of lines.entries()) {
    if (!head.test(line)) continue;
    const base = line.match(/^ */)[0].length;
    const block = {};
    let entry = null;
    for (const l of lines.slice(start + 1)) {
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const indent = l.match(/^ */)[0].length;
      if (indent <= base) break;
      const kv = l.match(/^\s*([\w-]+):\s*(.*?)(?:\s+#.*)?$/);
      if (!kv) continue;
      if (indent === base + 2) entry = block[kv[1]] = { value: kv[2] };
      else if (entry && indent === base + 4) entry[kv[1]] = kv[2];
    }
    out.push(block);
  }
  return out;
}

export function workflowInterface(src) {
  const declared = (head) =>
    Object.fromEntries(Object.entries(blocks(src, head)[0] ?? {}).map(([name, a]) => [name, { required: a.required === "true" }]));
  // Every job's permissions, the highest level per scope: what a caller must grant.
  const permissions = {};
  for (const block of blocks(src, /^ {4}permissions:$/)) {
    for (const [scope, { value }] of Object.entries(block)) {
      if ((LEVEL[value] ?? 0) > (LEVEL[permissions[scope]] ?? 0)) permissions[scope] = value;
    }
  }
  return { inputs: declared(/^ {4}inputs:$/), secrets: declared(/^ {4}secrets:$/), permissions };
}

/**
 * What a caller written for `before` cannot do against `after`, both `{ file: source }` maps of
 * the reusable workflows. A caller fails before its run starts on any of these.
 */
export function breakingChanges(before, after) {
  const out = [];
  for (const [file, src] of Object.entries(before)) {
    if (!(file in after)) {
      out.push(`${file} is gone or renamed: every caller's \`uses:\` names it`);
      continue;
    }
    const was = workflowInterface(src);
    const now = workflowInterface(after[file]);
    for (const kind of ["inputs", "secrets"]) {
      const one = kind.slice(0, -1);
      for (const name of Object.keys(was[kind])) {
        if (!(name in now[kind])) out.push(`${file}: ${one} \`${name}\` is gone, and a caller passing it fails`);
      }
      for (const [name, { required }] of Object.entries(now[kind])) {
        if (required && !was[kind][name]?.required) out.push(`${file}: ${one} \`${name}\` is now required`);
      }
    }
    for (const [scope, level] of Object.entries(now.permissions)) {
      const had = was.permissions[scope] ?? "none";
      if (LEVEL[level] > LEVEL[had]) out.push(`${file}: the job now needs \`${scope}: ${level}\` (was ${had}), beyond what installed callers grant`);
    }
  }
  return out;
}

// A conventional-commit subject marked breaking: `feat!:`, `fix(scope)!:`. The same pattern
// scripts/release-version.sh reads as a major bump.
export const marksBreaking = (subject) => /^[a-z]+(\([^)]*\))?!:/.test(subject);
