# CLAUDE.md

**github-actions** — the reusable GitHub Actions workflows behind the Claude Code integration: the `@claude` tag workflow, the PR review, the review fixer and the auto-merge gate. Plain YAML plus a zero-dependency Node.js test suite; no build step. Moved out of `fixdings/claude-setup`, whose `github` flow installs a thin **caller** for each into a repo's `.github/workflows/`; the callers live there, in `claude/integrations/github/`.

## Commands

- `npm test` (`node tests/all.mjs`) — the suite. Runs on a checkout with no `node_modules`; CI (`.github/workflows/ci.yml`) proves it on every PR.

## Repo Structure

- `.github/workflows/reusable-claude.yml` · `reusable-claude-code-review.yml` · `reusable-claude-review-fix.yml` · `reusable-claude-auto-merge.yml` — the workflows, each `on: workflow_call`. Callers reference them as `fixdings/github-actions/.github/workflows/reusable-<name>.yml@v1`.
- `.github/workflows/claude.yml` · `claude-code-review.yml` · `claude-review-fix.yml` — this repo's own callers, the same shape as claude-setup's but calling the local `./.github/workflows/reusable-*.yml`, so a PR here reviews itself with its own changes.
- `tests/` — `workflows.test.mjs` (allowlists, prompts, the gate's and the fixer's shell run against a fake `gh`) and `review-crash-note.test.mjs`, sharing `helpers.mjs`. `all.mjs` imports every top-level `*.test.mjs`.
- `.claude/rules/claude-code-action.md` — read before touching a reusable workflow: which doc governs which setting.

## Rules

- **A caller owns `on:`, `run-name:`, `concurrency:` and the job `permissions:`; a reusable workflow owns everything else.** A reusable workflow takes `workflow_call` only, has no workflow-level `concurrency` (it would be evaluated in the caller's context and share the caller's group) and reads no `vars` — a caller variable comes in as an input. The test suite enforces all three.
- **The `github` context in a reusable workflow is the caller's.** `github.event`, `github.workflow_ref` and `github.run_id` describe the caller's run, which is what lets the review count its rounds by the caller's file and the gate pin `.github/workflows/claude-code-review.yml` as the review's path.
- **Permissions only narrow.** A called job can drop a permission its caller granted, never add one. A permission added here must be added to every caller in claude-setup (`claude/integrations/github/`) in the same change, or every caller's run fails before it starts.
- **Releases are tags.** Callers pin the floating major `v1`. After a change merges, tag `v1.<minor>.<patch>` and move `v1` to it: `git tag -f v1 <sha> && git push --force-with-lease origin refs/tags/v1`. A breaking change to an input or a secret is `v2`, with the callers moved in claude-setup.
- **The token is handed over by name.** The callers pass `CLAUDE_CODE_OAUTH_TOKEN` explicitly rather than `secrets: inherit`, which does not cross owners — a caller may belong to another account.
- **The review prompt and `watch-pr` share their round rules.** A cross-repo test reads `fixdings/spec-workflow`'s `watch-pr` from a sibling `../spec-workflow` checkout (or `$SPEC_WORKFLOW_DIR`) and is **skipped**, never passed, without one.
