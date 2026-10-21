#!/bin/sh
# One-time GitHub setup for pseudovar/herdr-plugin-token-usage.
#
#   scripts/setup-github.sh            create the repo, push, and apply the settings below
#   scripts/setup-github.sh --list     also add the `herdr-plugin` topic (lists it in herdr's marketplace)
#
# Uses the `pseudovar` gh login without switching your active gh account (the
# plugin's Copilot quota lookup uses whichever account is active).
set -eu

OWNER=pseudovar
NAME=herdr-plugin-token-usage
REPO="$OWNER/$NAME"
SITE="https://$OWNER.github.io/$NAME/"

GH_TOKEN=$(gh auth token --user "$OWNER")
export GH_TOKEN
cd "$(dirname "$0")/.."

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Creating $REPO (public)…"
  gh repo create "$REPO" --public --description "Live token usage, GitHub Copilot credits, cost and performance for every coding agent in herdr." --homepage "$SITE" --disable-wiki
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/$REPO.git"
fi
# Push with the pseudovar token, without storing it in git's config.
git -c credential.helper= -c "credential.helper=!f() { echo username=$OWNER; echo password=$GH_TOKEN; }; f" push -u origin main --tags

echo "Applying repository settings…"
gh api -X PATCH "repos/$REPO" \
  -f homepage="$SITE" \
  -F has_issues=true -F has_discussions=true -F has_projects=false -F has_wiki=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true -F allow_auto_merge=true -F allow_update_branch=true >/dev/null

topics='"herdr","ai-agents","coding-agents","token-usage","github-copilot","claude-code","opencode","terminal","tui","typescript"'
if [ "${1:-}" = "--list" ]; then topics="\"herdr-plugin\",$topics"; fi
echo "{\"names\":[$topics]}" | gh api -X PUT "repos/$REPO/topics" --input - >/dev/null

# GitHub Pages, built and deployed by .github/workflows/docs.yml.
gh api -X POST "repos/$REPO/pages" -f build_type=workflow >/dev/null 2>&1 || gh api -X PUT "repos/$REPO/pages" -f build_type=workflow >/dev/null
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null
gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null

# Protect main: changes arrive through pull requests that pass CI and the PR-title check.
if ! gh api "repos/$REPO/rulesets" --jq '.[].name' | grep -qx "main"; then
  gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [
      { "context": "Test (ubuntu-latest, Node 24.x)" },
      { "context": "Test (macos-latest, Node 24.x)" },
      { "context": "Manifest and versions" },
      { "context": "Docs build" },
      { "context": "conventional" }
    ] } }
  ]
}
JSON
fi

# Labels the issue forms use.
gh label create harness --color 94e2d5 --description "Harness support or format change" --force >/dev/null
gh label create "autorelease: pending" --color cba6f7 --description "release-please" --force >/dev/null
gh label create "autorelease: tagged" --color a6e3a1 --description "release-please" --force >/dev/null

# The initial release; release-please takes over from here.
version=$(node -p 'require("./package.json").version')
if ! gh release view "v$version" >/dev/null 2>&1; then
  awk "/^## $version /{flag=1; next} /^## /{flag=0} flag" CHANGELOG.md > /tmp/tu-release-notes.md
  gh release create "v$version" --title "v$version" --notes-file /tmp/tu-release-notes.md --verify-tag
fi

cat <<EOF

Done: https://github.com/$REPO
Docs: $SITE (live once the Docs workflow finishes)

Two settings need the web UI:
  - Social preview: Settings → General → Social preview → upload docs/public/shots/social-preview.png
  - Optional: Settings → Code security → CodeQL analysis → "Default" setup
EOF
