#!/usr/bin/env bash
set -euo pipefail

[[ "$RADAR_PR" =~ ^[0-9]+$ ]] || { echo "::error::Unexpected pull request number"; exit 1; }
export GH_HOST="${GITHUB_SERVER_URL#https://}"

resp="$RUNNER_TEMP/radar-gh.out"
err="$RUNNER_TEMP/radar-gh.err"
api() {
  gh api "$@" > "$resp" 2> "$err" && return
  if grep -q 'HTTP 403' "$err"; then
    echo "::warning::Cannot write the pull request comment (HTTP 403). Fork pull requests get a read-only token; otherwise grant pull-requests: write."
    exit 0
  fi
  echo "::error::GitHub API: $(tr '\r\n' '  ' < "$err")"
  exit 1
}

# Only our own or a maintainer's marker comment is reused, never one a PR author planted.
api --paginate "repos/$GITHUB_REPOSITORY/issues/$RADAR_PR/comments" \
  --jq '.[] | select((.body // "") | startswith("<!-- offseq-radar-scan -->")) | select(.user.type == "Bot" or (.author_association | IN("OWNER", "MEMBER", "COLLABORATOR"))) | .id'
existing=$(head -n 1 "$resp")

clean=$(jq -r '.data as $d | ($d.gate.tripped != true and $d.gate.incomplete != true and ($d.summary.new // 0) == 0 and ($d.summary.resolved // ($d.resolved // [] | length)) == 0)' "$RADAR_REPORT")
if [ -z "$existing" ] && [ "$clean" = true ]; then
  echo "No new findings; no comment needed."
  exit 0
fi

payload="$RUNNER_TEMP/radar-comment.json"
jq '{body: ("<!-- offseq-radar-scan -->\n" + .markdown)} | .body |= if length > 65536 then .[0:65400] + "\n\n…truncated. See the job summary for the full report.\n" else . end' "$RADAR_REPORT" > "$payload"

if [ -n "$existing" ]; then
  api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing" --input "$payload" --jq .html_url
else
  api -X POST "repos/$GITHUB_REPOSITORY/issues/$RADAR_PR/comments" --input "$payload" --jq .html_url
fi
echo "comment-url=$(cat "$resp")" >> "$GITHUB_OUTPUT"
