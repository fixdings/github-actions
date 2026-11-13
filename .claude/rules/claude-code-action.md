---
paths:
  - ".github/workflows/{tag,review,review-fix,auto-merge}.yml"
  - "actions/**"
---

**Look up the input you are touching, read its page, and name that page in your response.** Naming the page is the point: an unread doc leaves no trace, so the omission has to be visible in the transcript or it goes unnoticed.

These files mix five separate configuration surfaces. Identify which one a setting belongs to before looking for a page, because each has its own docs and the others will not answer:

1. **A `with:` input on the `anthropics/claude-code-action` step.** <https://github.com/anthropics/claude-code-action/blob/main/action.yml> is the authoritative list — the README does not enumerate inputs, so an input that is not in `action.yml` on the pinned ref does not exist. <https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md> carries a one-line description of every input in a single table; from there go to `docs/security.md` for anything about access control, token scopes or commit signing, `docs/configuration.md` for MCP servers and advanced settings, `docs/capabilities-and-limitations.md` for what a run can and cannot do, and `docs/migration-guide.md` if an input looks renamed.
2. **Anything inside `claude_args`.** These are Claude Code CLI flags passed straight through, not action inputs — <https://code.claude.com/docs/en/cli-reference#cli-flags>, and <https://code.claude.com/docs/en/permissions> for the rule syntax inside `--allowedTools`. Searching the action's docs for them comes up empty.
3. **`permissions:`, `jobs.*.if`, `uses:`, `run:`.** GitHub Actions workflow syntax → <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax>.
4. **`actions/*/action.yml`** — composite-action metadata (`inputs:`, `outputs:`, `runs.using: composite`) → <https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax>.
5. **`on: workflow_call`, its `inputs:`/`secrets:`, and what a called workflow can see.** <https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations>. The `github` context is the caller's; `permissions` can only be narrowed here, never raised; caller `env` does not propagate.

- **`tag.yml`, `review.yml` and `review-fix.yml` pin `claude-code-action@v1`, a floating major.** The implementation moves under that tag, so never rely on recalled behavior for a token, a default, or an input name — re-read `action.yml` at the ref rather than trusting that an input still works the way it did.
- **The workflow `permissions:` block does not bound Claude, and `--allowedTools` is the thing that does.** claude-code-action exchanges the OIDC token for a Claude App token whose scopes are its defaults plus `additional_permissions`, so only those lines hold a run to read-only. Both facts are regression-tested in `tests/workflows.test.mjs` — read them there before changing either, rather than re-deriving them.
- **`--allowedTools` is the ceiling, so never widen it to a family.** Only the text before a rule's first `*` constrains anything: `Bash(gh *)` reaches `gh api`, `Bash(git *)` reaches `git -c <prog>`, `Bash(node *)` is `node -e`, and the PR diff is untrusted input. So a wildcard rule names a reviewed program (`gh`, `git`, `npm`, `yarn`, `cat`, `diff`, `grep`, `ls`, `printf`, `wc`) and, for a dispatcher, pins its subcommand in the literal prefix (`Bash(gh pr view:*)`). `Bash(gh api:*)` and `Bash(find:*)` are never granted: arbitrary write and exec however they are spelled. The one interpreter grant is `Bash(node tests/*)` in `review.yml`, which assumes this repo's `tests/` layout and whose prefix still reaches the whole checkout (`node tests/../x.js`). `tests/workflows.test.mjs` enforces each of these; a new runner fails closed until it is added to its list on purpose.
- **A permission added to a called job must reach every caller too** — see `reusable-workflows.md`.
