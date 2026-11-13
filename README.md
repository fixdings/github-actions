# github-actions

Reusable GitHub Actions workflows for the Claude Code integration, and the caller files a repo installs to use them.

| Workflow | Caller | Caller trigger | What it does |
|---|---|---|---|
| `tag.yml` | `claude.yml` | `issue_comment`, `pull_request_review_comment` | Runs Claude when a comment says `@claude`. |
| `review.yml` | `claude-code-review.yml` | `pull_request` | Reviews the PR and ends on `Round <n> of <budget> · VERDICT: CLEAN \| BLOCKING <k>`. |
| `review-fix.yml` | `claude-review-fix.yml` | `workflow_run` of the review | Fixes a blocking round on a PR Claude opened. |
| `auto-merge.yml` | `claude-auto-merge.yml` | `workflow_run` of the review | Merges a PR whose review is CLEAN, or labels it `needs-human`. Opt-in. |

## Layout

```
.github/workflows/   the four reusable workflows above, three of the callers (this repo runs them too), ci.yml, release.yml and release-check.yml
actions/<name>/      a composite action per scripted step: action.yml and the run.sh it runs
callers/             manifest.json, listing every caller a repo installs, and the one caller this repo does not run: claude-auto-merge.yml
scripts/             this repo's own tooling: release-version.sh, breaking-changes.mjs and the workflow-interface.mjs it shares with the tests
tests/               node tests/all.mjs — no dependencies
```

GitHub loads workflows only from the top level of `.github/workflows/`, so the folders are under `actions/`. A reusable workflow checks out this repo at `job.workflow_sha`, the commit of the workflow being called, and runs its actions from there. A caller pinned to any tag therefore runs the scripts released with it. That uses the `job.workflow_*` context, which GitHub Enterprise Server does not provide.

## Installing the callers

`fixdings/claude-setup` (`node cli/setup.mjs github`) installs them: it reads `callers/manifest.json` and copies each file it names, unchanged, into the target repo's `.github/workflows/`. There is one copy of each caller. The three this repo runs on its own PRs live in its `.github/workflows/`; the auto-merge gate, which must not run here, lives in `callers/`.

| Field | Meaning |
|---|---|
| `callers[].source` | The file's path in this repo. It is installed as `.github/workflows/<its file name>`. |
| `callers[].group` | `claude`: the three installed together. `auto-merge`: the opt-in gate. |
| `callers[].vars` | Repo variables the caller reads; all optional. |
| `secrets` | Repo or org secrets the callers pass on. |

Fetch them from the **floating major tag the callers pin**, `v2`. Every release moves that tag, so this always gets the latest callers, and they call the workflows of the same release line. The repo is public, so no token is needed:

```sh
curl -fsSL https://raw.githubusercontent.com/fixdings/github-actions/v2/callers/manifest.json
curl -fsSL https://raw.githubusercontent.com/fixdings/github-actions/v2/.github/workflows/claude.yml   # each `source`
# or, through gh:
gh api "repos/fixdings/github-actions/contents/callers/claude-auto-merge.yml?ref=v2" -H "Accept: application/vnd.github.raw"
```

The target repo also needs:
- **the Claude GitHub App** installed on it;
- **the secret** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), on the repo or shared from the org;
- an **Actions policy** that allows `fixdings/github-actions`, `anthropics/claude-code-action` and `actions/checkout`;
- for auto-merge: **squash merging** allowed and **0 required approvals** (the gate's merge counts as none).

A caller owns `on:`, `run-name:`, `concurrency:` and the job `permissions:`. A called job can only narrow `permissions:`, so a caller's block is the ceiling its workflow needs; don't trim it. Keep the review caller's `name:` and its path, `.github/workflows/claude-code-review.yml`: the fixer and the gate match the review run by both.

### Inputs

- `review.yml` — `round-budget`, from `vars.CLAUDE_CODE_REVIEW_ROUND_BUDGET`: the round budget shown in the status line. Empty, or anything but a whole number of at least 1, means 3.
- `auto-merge.yml` — `sensitive-paths`, from `vars.REVIEW_SENSITIVE_PATHS`: a space-separated list of paths that stop a merge. An entry ending in `/` is a directory prefix, an entry with no `/` is a file name at any depth, anything else is an exact path, and a leading `!` makes an exception. Empty means the built-in list: `.github/`, `.claude/` except `.claude/specs/`, and the config files claude-code-action restores from the base branch.

## Development

`npm test` runs the suite: no dependencies, Node 24. It checks the workflows' allowlists and prompts, the layout above, that every caller grants what its workflow needs, and runs every action script against a fake `gh`. CI runs it on every PR.

This repo reviews its own PRs with the **released** workflows: its `claude.yml`, `claude-code-review.yml` and `claude-review-fix.yml` are the installed callers, pinned to `@v2` like everyone's. So a change to `review.yml` or `actions/` is first run live once it is released, when every installed caller gets it too; the suite is what holds it before then. A PR that moves the callers to a new major points them at a tag that does not exist yet, so this repo's own Claude runs fail until that PR's release creates it.

## Versions

Callers pin the floating major. `v1` keeps the old `reusable-claude*.yml` file names; `v2` renamed them to the four above.

Every merge into `main` is released by `.github/workflows/release.yml`. The squash commit's conventional-commit type picks the bump:

| Commit | Release |
|---|---|
| `feat!: …`, `fix(x)!: …`, or a `BREAKING CHANGE:` footer | major: `v2.0.0`, and a new floating `v2` |
| `feat: …` | minor: `v1.1.0` |
| anything else (`fix:`, `docs:`, `chore:` …) | patch: `v1.0.1` |

The job tags the version, moves the floating major to it and publishes a [release](https://github.com/fixdings/github-actions/releases) whose notes list the PRs merged since the previous version. Once a newer major exists, the older one gets no more releases from `main`.

A change to a caller reaches a repo only when its setup is re-run. If existing callers break without it (a new required permission, input or secret), it is a `!` change. The `Release check` workflow fails a PR that does this without a `!` in its title: it compares the reusable workflows with the last release, and a workflow removed or renamed, an input or secret removed or newly required, or a job permission added, needs the `!`. Editing the title re-runs it.
