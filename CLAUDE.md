# CLAUDE.md

**github-actions** — the reusable GitHub Actions workflows behind the Claude Code integration: the `@claude` tag workflow, the PR review, the review fixer and the auto-merge gate. YAML and shell plus a zero-dependency Node.js test suite; no build step. Moved out of `fixdings/claude-setup`. The thin **callers** a repo installs live here too, in `callers/`; claude-setup's `github` flow fetches them from the floating major tag and copies them into a repo's `.github/workflows/`.

## Commands

- `npm test` (`node tests/all.mjs`) — the suite. Runs on a checkout with no `node_modules`; `ci.yml` proves it on every PR and `release.yml` again before every release.
- `actionlint -shellcheck= .github/workflows/*.yml` — optional lint. Version 1.7.12 does not know `job.workflow_repository`/`job.workflow_sha` yet and reports them; nothing else should appear.

**The PR title decides the release:** `feat!:` major, `feat:` minor, anything else patch — see `releases.md`.

## Topic rules (`.claude/rules/`)

Path-scoped, loaded when you open a file they cover. Read the one that matches before changing that area:

| Rule | Covers | Loads when you touch |
|---|---|---|
| `reusable-workflows.md` | caller vs reusable workflow, `callers/`, the `github` vs `job` context, the actions checkout, script conventions, permissions, the token, the cross-repo test | `.github/workflows/`, `actions/`, `callers/`, the workflow and caller tests |
| `claude-code-action.md` | which doc governs which setting; `claude-code-action@v1` floats; `--allowedTools`, not `permissions:`, bounds Claude | the four reusable workflows, `actions/` |
| `releases.md` | the automatic release, how a commit message picks the version, the release check, floating majors | `release.yml`, `release-check.yml`, `scripts/`, the release test, the PR template |

## Repo Structure

- `.github/workflows/tag.yml` · `review.yml` · `review-fix.yml` · `auto-merge.yml` — the reusable workflows, each `on: workflow_call`. Callers reference them as `fixdings/github-actions/.github/workflows/<name>.yml@v2`. GitHub reads no subfolder of `.github/workflows/`.
- `actions/<name>/` — `action.yml` (a composite action: inputs, the env its script reads) and `run.sh`. One per scripted step; `review-*` serve `review.yml`, `review-fix-*` serve `review-fix.yml`, `auto-merge` is the gate. `actions/lib/` holds the shell they share (`run-comment.sh`, `needs-human.sh`), sourced, not run.
- `.github/workflows/claude.yml` · `claude-code-review.yml` · `claude-review-fix.yml` — callers a repo installs, which this repo runs too: they call the released `fixdings/github-actions/.github/workflows/<name>.yml@v2`, so this repo is reviewed by what everyone runs. One copy each: these are the installed files.
- `callers/` — `manifest.json` (every caller's source path, group, repo variables, secrets) for claude-setup to read, and `claude-auto-merge.yml`, the opt-in gate, kept out of `.github/workflows/` so nothing merges itself here.
- `.github/workflows/ci.yml` · `release.yml` · `release-check.yml` — this repo only: the suite on every PR, a release on every merge, and a check that a PR breaking installed callers carries `!` in its title.
- `scripts/` — this repo's own tooling: `release-version.sh` (the next version), `breaking-changes.mjs` (the release check) and `workflow-interface.mjs` (a reusable workflow's inputs, secrets and permissions, shared with the tests).
- `tests/` — `workflows.test.mjs` (allowlists, prompts, the layout, and the action scripts run against a fake `gh`), `callers.test.mjs` (every caller against its workflow: file, permissions, secrets, inputs, the manifest, this repo's copies), `review-crash-note.test.mjs`, `release.test.mjs` and `breaking.test.mjs` (the release check), sharing `helpers.mjs`. `all.mjs` imports every top-level `*.test.mjs`.
