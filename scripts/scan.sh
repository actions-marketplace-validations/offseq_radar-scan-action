#!/usr/bin/env bash
set -euo pipefail

die() { echo "::error::$*"; exit 1; }
out() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }
bool() { case "$2" in true|false) ;; *) die "$1 must be true or false, not '$2'" ;; esac; }

if [ -z "$RADAR_API_KEY" ]; then
  # Fail closed: a missing secret anywhere else must not pass the gate.
  [ "$RADAR_NO_SECRETS" = true ] || die "api-key is empty. Set the RADAR_API_KEY secret."
  echo "::warning::No Radar API key (secrets are not passed to fork or Dependabot pull requests); skipping the scan."
  out skipped true
  exit 0
fi

case "$RADAR_FAIL_ON" in
  ''|critical|high|medium|low|kev|exploited|act-now) ;;
  *) die "fail-on must be critical, high, medium, low, kev, exploited, act-now or empty, not '$RADAR_FAIL_ON'" ;;
esac
case "$RADAR_GATE" in ''|new|all) ;; *) die "gate must be new, all or empty, not '$RADAR_GATE'" ;; esac
case "$RADAR_COMMENT" in ''|true|false) ;; *) die "comment must be true, false or empty, not '$RADAR_COMMENT'" ;; esac
bool fail-on-incomplete "$RADAR_FAIL_ON_INCOMPLETE"
bool upload-sarif "$RADAR_UPLOAD"
bool fix-prs "$RADAR_FIX_PRS"
bool allow-major "$RADAR_ALLOW_MAJOR"
case "$RADAR_URL" in http://*|https://*) ;; *) die "api-url must start with https:// or http://" ;; esac
[[ "$RADAR_BASE_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})?$ ]] || die "Unexpected base SHA"
[[ "$RADAR_HEAD_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})?$ ]] || die "Unexpected head SHA"

if [ -n "$RADAR_BASE_SHA" ]; then
  # Otherwise every file compares as unchanged and the gate passes vacuously (pull_request_target checks out the base).
  if [ "$(git rev-parse HEAD)" != "$RADAR_HEAD_SHA" ] && ! git cat-file commit HEAD | grep -qx "parent $RADAR_HEAD_SHA"; then
    die "The checked-out commit is not the pull request head or its merge commit. Check out the pull request (actions/checkout with ref: \${{ github.event.pull_request.head.sha }})."
  fi
  git cat-file -e "$RADAR_BASE_SHA^{commit}" 2>/dev/null ||
    git fetch --quiet --no-tags --depth=1 origin "$RADAR_BASE_SHA" || die "Could not fetch the pull request base $RADAR_BASE_SHA"
fi

body="$RUNNER_TEMP/radar-body.json"
files="$RUNNER_TEMP/radar-files.json"
report="$RUNNER_TEMP/radar-scan.json"
node "$GITHUB_ACTION_PATH/scripts/prepare.mjs" "$body" "$files"
out files "$files"

n=$(jq '.files | length' "$files")
if [ "$n" = 0 ]; then
  echo "::warning::No supported lockfile or SBOM is tracked in this repository; nothing to scan."
  out skipped true
  exit 0
fi
echo "Scanning $n file(s): $(jq -r '.files | map("\(.filename) (\(.mode))") | join(", ")' "$files")"

query="format=all${RADAR_FAIL_ON:+&failOn=$RADAR_FAIL_ON}${RADAR_GATE:+&gate=$RADAR_GATE}"
status=$(curl -sS -o "$report" -w '%{http_code}' -X POST "${RADAR_URL%/}/api/v1/scan?$query" \
  -H "X-API-Key: $RADAR_API_KEY" -H 'Content-Type: application/json' --data-binary "@$body")
if [ "$status" != 200 ]; then
  die "Radar scan failed (HTTP $status): $(jq -r '.message // .error // empty | gsub("[\\r\\n]+"; " ")' "$report" 2>/dev/null || true)"
fi

jq -r '.markdown' "$report" >> "$GITHUB_STEP_SUMMARY"
jq -r '(.data.truncated // []) as $t | select($t | length > 0) |
  "\n**Incomplete:** \($t | length) package(s) not fully evaluated: \($t | map("`\(.purl)` (\(.reason))") | join(", "))."' "$report" >> "$GITHUB_STEP_SUMMARY"
out report "$report"
out gate-tripped "$(jq -r '.data.gate.tripped == true' "$report")"
out gate-incomplete "$(jq -r '.data.gate.incomplete == true' "$report")"
out new-findings "$(jq -r '.data.summary.new // 0' "$report")"
out resolved-findings "$(jq -r '.data.summary.resolved // (.data.resolved // [] | length)' "$report")"

if [ "$RADAR_UPLOAD" = true ]; then
  jq '.sarif' "$report" > "$RUNNER_TEMP/radar.sarif"
  out sarif-file "$RUNNER_TEMP/radar.sarif"
fi
