---
paths:
  - ".github/workflows/**"
  - "actions/**"
  - "callers/**"
  - "tests/workflows.test.mjs"
  - "tests/callers.test.mjs"
  - "tests/review-crash-note.test.mjs"
---

# Reusable workflows, their callers and their actions

- **A caller owns `on:`, `run-name:`, `concurrency:` and the job `permissions:`; a reusable workflow owns everything else.** A reusable workflow takes `workflow_call` only, has no workflow-level `concurrency` (it would be evaluated in the caller's context and share the caller's group) and reads no `vars` — a caller variable comes in as an input. The suite enforces all three.
- **The callers are shipped from here, one copy each.** claude-setup fetches `callers/manifest.json` and the files it names (each entry's `source`) from the floating major tag and copies them unchanged into a repo, so a caller is edited here, never in claude-setup. The three this repo runs live in `.github/workflows/` and ARE the installed files; the gate lives in `callers/`, since it must not run here. Every caller pins `@v<major>` — the same major for all — and a new major moves the pins in the same change. `callers.test.mjs` checks each caller against the workflow it calls, and that every file calling this repo at a release is in the manifest.
- **This repo reviews itself with the released workflows.** Its callers pin `@v2` like everyone's, so a PR's change to `review.yml` or `actions/` first runs live after its release — the suite is what holds it until then. A PR moving the callers to a new major points this repo's own runs at a tag its release creates, so they fail until it merges.
- **The `github` context in a reusable workflow is the caller's.** `github.event`, `github.workflow_ref` and `github.run_id` describe the caller's run, which is what lets the review count its rounds by the caller's file and the gate pin `.github/workflows/claude-code-review.yml` as the review's path. The review caller's `name:` and path are therefore an interface: the fixer and the gate match the review run by both.
- **A workflow runs its actions from `job.workflow_sha`, never from a tag.** Each job checks this repo out at `${{ job.workflow_repository }}`/`${{ job.workflow_sha }}` into `.fixdings-actions/` (sparse `actions/`, no credentials) and calls `./.fixdings-actions/actions/<name>`. `job.*` names the called workflow where `github.*` names the caller, so a caller pinned to any tag runs the scripts released with it. Not on GitHub Enterprise Server, which has no `job.workflow_*`.
- **That checkout comes AFTER any checkout of the PR.** `actions/checkout` empties a workspace that is not its repo, so the fixer checks the actions out twice. The review and the fixer add `/.fixdings-actions/` to `.git/info/exclude`, so Claude's Grep, Glob and `git status` see the PR alone. The suite enforces the order.
- **A script sets its own `set -eo pipefail`.** A `run:` block got `bash -e` with pipefail from the runner; a file run as `bash run.sh` gets neither. Values reach a script through its `action.yml`'s `env:`, never a `${{ }}` inside it — a PR-controlled value (a branch name, a comment body) is only ever quoted.
- **Every action under `actions/` serves a reusable workflow.** Tooling for this repo alone goes in `scripts/` — the suite fails on an action no workflow uses.
- **Permissions only narrow.** A called job can drop a permission its caller granted, never add one. A permission added to a reusable job must be added to its caller in `callers/` in the same change (the suite fails otherwise) — but installed callers only get it when their repo's setup is re-run, so until then every run fails before it starts: a breaking change (`!`, see `releases.md`).
- **The token is handed over by name.** The callers pass `CLAUDE_CODE_OAUTH_TOKEN` explicitly rather than `secrets: inherit`, which does not cross owners — a caller may belong to another account.
- **The review prompt and `watch-pr` share their round rules.** A cross-repo test reads `fixdings/spec-workflow`'s `watch-pr` from a sibling `../spec-workflow` checkout (or `$SPEC_WORKFLOW_DIR`) and is **skipped**, never passed, without one.
