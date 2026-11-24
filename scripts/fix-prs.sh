#!/usr/bin/env bash
set -euo pipefail

export GH_HOST="${GITHUB_SERVER_URL#https://}"
fix="$GITHUB_ACTION_PATH/scripts/fix.mjs"
tmp="$RUNNER_TEMP/radar-fix"
mkdir -p "$tmp"

case "$GITHUB_EVENT_NAME" in
  push|schedule|workflow_dispatch) ;;
  *) echo "fix-prs runs on push, schedule and workflow_dispatch only."; exit 0 ;;
esac
default=$(gh api "repos/$GITHUB_REPOSITORY" --jq .default_branch)
if [ "$GITHUB_REF" != "refs/heads/$default" ]; then
  echo "fix-prs runs on the default branch ($default) only."
  exit 0
fi

root=$(git rev-parse --show-toplevel)
cd "$root"
start=$(git rev-parse HEAD)
origin_ref=$(git symbolic-ref -q --short HEAD || true)
trap 'git reset -q "$start" && git checkout -q "${origin_ref:-$start}"' EXIT
git checkout -q --detach
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

config_json=null
[ -f "$RADAR_CONFIG" ] && config_json=$(jq -Rs . "$RADAR_CONFIG")

mapfile -t locks < <(jq -r '.files[].filename | select(test("(^|/)package-lock\\.json$"))' "$RADAR_FILES")
urls=()
failed=0
for lock in "${locks[@]}"; do
  dir=$(dirname "$lock")
  manifest="$dir/package.json"
  if [ ! -f "$manifest" ]; then
    echo "::warning::$lock has no package.json beside it; no fix PR."
    continue
  fi

  jq -n --rawfile manifest "$manifest" --rawfile lockfile "$lock" --arg filename "$lock" \
    --argjson config "$config_json" --argjson allowMajor "$RADAR_ALLOW_MAJOR" \
    '{manifest: $manifest, lockfile: $lockfile, filename: $filename, allowMajor: $allowMajor} + (if $config then {config: $config} else {} end)' > "$tmp/request.json"
  status=$(curl -sS -o "$tmp/plan.json" -w '%{http_code}' -X POST "${RADAR_URL%/}/api/v1/fix/plan" \
    -H "X-API-Key: $RADAR_API_KEY" -H 'Content-Type: application/json' --data-binary "@$tmp/request.json")
  if [ "$status" = 403 ]; then
    echo "::warning::Fix PRs need a paid Radar plan: $(jq -r '.message // .error // empty | gsub("[\\r\\n]+"; " ")' "$tmp/plan.json" 2>/dev/null || true)"
    break
  fi
  if [ "$status" != 200 ]; then
    echo "::error::Radar fix plan for $lock failed (HTTP $status): $(jq -r '.message // .error // empty | gsub("[\\r\\n]+"; " ")' "$tmp/plan.json" 2>/dev/null || true)"
    failed=1
    continue
  fi

  node "$fix" filter "$tmp/plan.json" "$RADAR_ALLOW_MAJOR" > "$tmp/filtered.json"
  if [ "$(jq '.plan | length' "$tmp/filtered.json")" = 0 ]; then
    echo "No fixable vulnerabilities in $lock."
    continue
  fi

  node "$fix" apply "$manifest" "$tmp/filtered.json"
  mapfile -t updates < <(jq -r '.plan[] | select(.strategy == "update") | .name' "$tmp/filtered.json")
  if ! (cd "$dir" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund &&
        { [ "${#updates[@]}" = 0 ] || npm update "${updates[@]}" --package-lock-only --ignore-scripts --no-audit --no-fund; }); then
    echo "::error::npm could not update $lock."
    failed=1
    git checkout -q -- "$manifest" "$lock"
    continue
  fi

  node "$fix" verify "$lock" "$tmp/filtered.json" > "$tmp/verified.json"
  jq -r '.skipped[] | "Not fixed: \(.name): \(.reason)" | gsub("[\\r\\n]+"; " ")' "$tmp/verified.json"
  if [ "$(jq '.plan | length' "$tmp/verified.json")" = 0 ]; then
    echo "::warning::npm resolved none of the planned upgrades in $lock; no fix PR."
    git checkout -q -- "$manifest" "$lock"
    continue
  fi
  node "$fix" describe "$tmp/verified.json" "$lock" "$RADAR_REPORT" > "$tmp/pr.json"
  title=$(jq -r .title "$tmp/pr.json")
  jq -r .body "$tmp/pr.json" > "$tmp/body.md"

  slug=$([ "$dir" = . ] && echo root || echo "${dir//[^A-Za-z0-9_-]/-}")
  branch="offseq-radar/fix/$slug"
  [ "$branch" != "$default" ] || { echo "::error::Refusing to push to the default branch"; exit 1; }
  git add -- "$manifest" "$lock"
  git commit -q -m "$title"
  git push -q --force origin "HEAD:refs/heads/$branch"
  git reset -q "$start"
  git checkout -q -- "$manifest" "$lock"

  url=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$branch" --state open --json url --jq '.[0].url // empty')
  if [ -n "$url" ]; then
    gh pr edit "$url" --title "$title" --body-file "$tmp/body.md" > /dev/null
  elif ! url=$(gh pr create --repo "$GITHUB_REPOSITORY" --base "$default" --head "$branch" --title "$title" --body-file "$tmp/body.md" 2> "$tmp/gh.err"); then
    echo "::warning::Could not open a pull request for $branch: $(tr '\r\n' '  ' < "$tmp/gh.err"). Allow GitHub Actions to create pull requests in the repository settings (Actions → General → Workflow permissions)."
    continue
  fi
  echo "Fix PR for $lock: $url"
  urls+=("$url")
done

echo "fix-prs=$(printf '%s\n' "${urls[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')" >> "$GITHUB_OUTPUT"
exit "$failed"
