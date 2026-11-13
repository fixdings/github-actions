#!/usr/bin/env bash
# The next release, from the conventional-commit subjects since the last version tag. Run by
# .github/workflows/release.yml on every push to main; writes `version`, `previous` and `major`
# to $GITHUB_OUTPUT.
#
#   feat!: / fix(x)!: …   → major  (a renamed file, input or secret)
#   feat: / feat(x): …    → minor
#   anything else         → patch
#
# SUBJECTS ONLY. A squash merge's subject is the PR title — what release-check.yml judges — and
# its body is the PR's description or its commits, which neither the check nor the reader takes
# as the release decision: a `BREAKING CHANGE:` line or a `feat:` there must not move the bump.
#
# A HEAD that IS the latest version is written out again, so a re-run of a release that failed
# after tagging (the major not moved, the release not published) finishes it rather than skipping.
set -eo pipefail

# Highest first by version order, not by date: a fix tagged on an older major after a newer one
# must not become the base.
tags=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname)
prev=$(printf '%s\n' "$tags" | sed -n 1p)
if [ -z "$prev" ]; then
  echo "::error::No vX.Y.Z tag to bump from. Tag the first release by hand."
  exit 1
fi

if [ "$(git rev-parse "$prev^{commit}")" = "$(git rev-parse HEAD)" ]; then
  version=$prev
  prev=$(printf '%s\n' "$tags" | sed -n 2p)
  echo "HEAD is already $version: finishing its release, if a run left it unfinished."
elif [ -z "$(git rev-list "$prev..HEAD")" ]; then
  echo "HEAD is behind $prev: nothing to release."
  exit 0
else
  subjects=$(git log --format=%s "$prev..HEAD")
  bump=patch
  if printf '%s\n' "$subjects" | grep -Eq '^[a-z]+(\([^)]*\))?!:'; then
    bump=major
  elif printf '%s\n' "$subjects" | grep -Eq '^feat(\([^)]*\))?:'; then
    bump=minor
  fi
  IFS=. read -r major minor patch <<< "${prev#v}"
  case "$bump" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
  esac
  version="v$major.$minor.$patch"
  echo "Release $version: a $bump bump from $prev."
fi
{
  echo "version=$version"
  echo "previous=$prev"
  echo "major=${version%%.*}"
} >> "$GITHUB_OUTPUT"
