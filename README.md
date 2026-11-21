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
.github/workflows/   the four reusable workflows above, ci.yml, release.yml and release-check.yml (no caller: this repo runs no Claude workflow)
actions/<name>/      a composite action per scripted step: action.yml and the run.sh it runs
callers/             manifest.json, and every caller a repo installs: claude.yml, claude-code-review.yml, claude-review-fix.yml and claude-auto-merge.yml
scripts/             this repo's own tooling: release-version.sh, breaking-changes.mjs and the workflow-interface.mjs it shares with the tests
tests/               node tests/all.mjs — no dependencies
```

GitHub loads workflows only from the top level of `.github/workflows/`, so the folders are under `actions/`. A reusable workflow checks out this repo at `job.workflow_sha`, the commit of the workflow being called, and runs its actions from there. A caller pinned to any tag therefore runs the scripts released with it. That uses the `job.workflow_*` context, which GitHub Enterprise Server does not provide.

## Installing the callers

An installer reads `callers/manifest.json` and copies each file it names, unchanged, into the target repo's `.github/workflows/`. There is one copy of each caller, all four in `callers/`, so none of them runs in this repo.

| Field | Meaning |
|---|---|
| `callers[].source` | The file's path in this repo. It is installed as `.github/workflows/<its file name>`. |
| `callers[].group` | `claude`: the three installed together. `auto-merge`: the opt-in gate. |
| `callers[].vars` | Repo variables the caller reads; all optional. |
| `secrets` | Repo or org secrets the callers pass on. |

Fetch them from the **floating major tag the callers pin**, `v2`. Every release moves that tag, so this always gets the latest callers, and they call the workflows of the same release line. The repo is public, so no token is needed:

```sh
curl -fsSL https://raw.githubusercontent.com/fixdings/github-actions/v2/callers/manifest.json
curl -fsSL https://raw.githubusercontent.com/fixdings/github-actions/v2/callers/claude.yml   # each `source`
# or, through gh:
gh api "repos/fixdings/github-actions/contents/callers/claude-auto-merge.yml?ref=v2" -H "Accept: application/vnd.github.raw"
```

The target repo also needs:
- **the Claude GitHub App** installed on it;
- **the secret** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), on the repo or shared from the org. A run on a Dependabot PR reads only **Dependabot secrets**, so to review those PRs add the same secret there too (`gh secret set CLAUDE_CODE_OAUTH_TOKEN --app dependabot`). The review admits `dependabot[bot]`, but treats it as an author without write access: the action denies it commands that run repository code, such as the test suite;
- an **Actions policy** that allows `fixdings/github-actions`, `anthropics/claude-code-action` and `actions/checkout`;
- for auto-merge: **squash merging** allowed. The gate approves the reviewed commit before it merges, so a repo that requires approvals also needs **"Allow GitHub Actions to create and approve pull requests"** (Settings → Actions → General; on the org first, which otherwise greys it out) and no Code Owners review, which the bot cannot give. With that setting off, the repo needs **0 required approvals**.

A caller owns `on:`, `run-name:`, `concurrency:` and the job `permissions:`. A called job can only narrow `permissions:`, so a caller's block is the ceiling its workflow needs; don't trim it. Keep the review caller's `name:` and its path, `.github/workflows/claude-code-review.yml`: the fixer and the gate match the review run by both.

### Inputs

- `review.yml` — `round-budget`, from `vars.CLAUDE_CODE_REVIEW_ROUND_BUDGET`: the round budget shown in the status line. Empty, or anything but a whole number of at least 1, means 3.
- `auto-merge.yml` — `sensitive-paths`, from `vars.REVIEW_SENSITIVE_PATHS`: a space-separated list of paths that stop a merge (a clean review of such a PR is still approved, at the reviewed commit, for a person to merge). An entry ending in `/` is a directory prefix, an entry with no `/` is a file name at any depth, anything else is an exact path, and a leading `!` makes an exception. Empty means the built-in list: `.github/`, `.claude/` except `.claude/specs/`, and the config files claude-code-action restores from the base branch.

## Development

`npm test` runs the suite: no dependencies, Node 24. It checks the workflows' allowlists and prompts, the layout above, that every caller grants what its workflow needs, and runs every action script against a fake `gh`. CI runs it on every PR.

This repo runs no Claude workflow on its own PRs: every caller lives in `callers/`. A change to `review.yml` or `actions/` is first run live once it is released, when every installed caller gets it; the suite is what holds it before then.

## Versions

Callers pin the floating major. `v1` keeps the old `reusable-claude*.yml` file names; `v2` renamed them to the four above.

Every merge into `main` is released by `.github/workflows/release.yml`. The conventional-commit type in the squash commit's subject, the PR title, picks the bump; the body never does:

| Subject | Release |
|---|---|
| `feat!: …`, `fix(x)!: …` | major: `v2.0.0`, and a new floating `v2` |
| `feat: …` | minor: `v1.1.0` |
| anything else (`fix:`, `docs:`, `chore:` …) | patch: `v1.0.1` |

The job pushes the version tag and the moved floating major together, atomically, and publishes a [release](https://github.com/fixdings/github-actions/releases) whose notes list the PRs merged since the previous version. A re-run of a release that failed part-way finishes it. Once a newer major exists, the older one gets no more releases from `main`.

A change to a caller reaches a repo only when its setup is re-run. If existing callers break without it (a new required permission, input or secret), it is a `!` change. The `Release check` workflow fails a PR that does this without a `!` in its title: it compares the reusable workflows with the last release, and a workflow removed or renamed, an input or secret removed or newly required, an input's type changed, or a job permission added, needs the `!`. So does a block it cannot read (`permissions: write-all`, a `{ … }` flow map): write those as one entry per line. Editing the title re-runs it.
