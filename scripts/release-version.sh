#!/usr/bin/env bash
# The next release, from the conventional-commit messages since the last version tag. Run by
# .github/workflows/release.yml on every push to main; writes `version`, `previous` and `major`
# to $GITHUB_OUTPUT, or nothing when HEAD is already released.
#
#   feat!: / fix(x)!: / a `BREAKING CHANGE:` footer  → major  (a renamed file, input or secret)
#   feat: / feat(x):                                  → minor
#   anything else                                     → patch
set -eo pipefail

# The highest vX.Y.Z by version order, not by date: a fix tagged on an older major after a newer
# one must not become the base.
prev=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | sed -n 1p)
if [ -z "$prev" ]; then
  echo "::error::No vX.Y.Z tag to bump from. Tag the first release by hand."
  exit 1
fi
if [ -z "$(git rev-list "$prev..HEAD")" ]; then
  echo "HEAD is already released as $prev (or is behind it): nothing to release."
  exit 0
fi

# Subjects and bodies, so a breaking-change footer counts. A squash merge's body lists the
# branch's commits as `* feat: …`, which the anchored patterns below do not read as a subject.
log=$(git log --format='%s%n%b' "$prev..HEAD")
bump=patch
if printf '%s\n' "$log" | grep -Eq '^[a-z]+(\([^)]*\))?!:|^BREAKING[ -]CHANGE:'; then
  bump=major
elif printf '%s\n' "$log" | grep -Eq '^feat(\([^)]*\))?:'; then
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
{
  echo "version=$version"
  echo "previous=$prev"
  echo "major=v$major"
} >> "$GITHUB_OUTPUT"
