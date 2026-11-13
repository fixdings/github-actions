---
paths:
  - ".github/workflows/release.yml"
  - ".github/workflows/release-check.yml"
  - "scripts/**"
  - "tests/release.test.mjs"
  - "tests/breaking.test.mjs"
  - ".github/pull_request_template.md"
---

# Releases

- **Every merge into `main` releases, and the squash commit's subject picks the version.** `.github/workflows/release.yml` runs the suite, then `scripts/release-version.sh` bumps from the highest `vX.Y.Z` tag over every subject since it: `feat!:`/`<type>(scope)!:` → major, `feat:` → minor, anything else → patch. Subjects only: a commit body (the PR description, or the squashed commits) never moves the bump, so a `BREAKING CHANGE:` footer alone does nothing — the `!` does. The job pushes the version and the floating major (`v1`, `v2`) in one `--atomic` push, the major under a `--force-with-lease`, and publishes a GitHub Release whose notes list the PRs since the previous version. Each part is done only if it is not yet, so re-running a release that failed part-way finishes it. Don't tag by hand.
- **The PR title is the release decision.** Set the repo's squash title to the PR title (`PR_TITLE`): under `COMMIT_OR_PR_TITLE` a one-commit PR's squash subject is that commit's, and the check below reads the PR title. A renamed workflow file, a removed or newly required input or secret, or a new job permission is a `!` — and the callers in `callers/` move with it.
- **The release check holds the title to it.** `.github/workflows/release-check.yml` runs `scripts/breaking-changes.mjs` on every PR (`edited` too, so a title fix re-runs it): it compares the reusable workflows' interface (`scripts/workflow-interface.mjs`) at the last release tag with the PR, and fails when something breaks a caller and the title has no `!`. Run it by hand with `node scripts/breaking-changes.mjs` to list what a branch breaks. Its rules and the tests' agree because they share that parser; the title pattern is held equal to `release-version.sh`'s by `tests/breaking.test.mjs`.
- **A caller change reaches a repo only when its setup is re-run**, which fetches the callers `callers/manifest.json` lists from the floating major tag. A change that leaves installed callers working is a minor or patch; one they break without a re-run (a new required permission, input or secret) is a `!`.
- **Callers pin the floating major.** `v1` keeps the old `reusable-claude*.yml` names. Once a newer major exists the older one gets no further release from `main`; a fix for it would need a branch off its last tag, which this workflow does not release.
- **A merge made with `GITHUB_TOKEN` starts no `push` workflow**, so a PR merged by an auto-merge gate would not release. This repo runs no gate.
