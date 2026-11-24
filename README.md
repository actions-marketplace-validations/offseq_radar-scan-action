# OffSeq Radar scan – GitHub Action

[![Test](https://github.com/offseq/radar-scan-action/actions/workflows/test.yml/badge.svg)](https://github.com/offseq/radar-scan-action/actions/workflows/test.yml)
[![CI](https://github.com/offseq/radar-scan-action/actions/workflows/ci.yml/badge.svg)](https://github.com/offseq/radar-scan-action/actions/workflows/ci.yml)

Checks your lockfiles and SBOMs against [OffSeq Threat Radar](https://radar.offseq.com), prioritised by CISA KEV, known exploitation, EPSS and Radar's act-now decision:

- on pull requests, reports only what the pull request **introduces** and what it **fixes**, in one comment that is updated on every push;
- writes the full report to the job summary and uploads SARIF to GitHub code scanning, with alerts on the lockfile line of each package;
- fails the job when a version-confirmed finding reaches the level you choose – by default only new findings count on pull requests;
- optionally opens pull requests that upgrade vulnerable npm packages (paid plans).

Each run makes one [`POST /api/v1/scan`](https://radar.offseq.com/api-docs) request for all files, so it costs one API request.

## Pull request checks

```yaml
name: Radar
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write     # the pull request comment
  security-events: write   # SARIF upload

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: offseq/radar-scan-action@v2
        with:
          api-key: ${{ secrets.RADAR_API_KEY }}
          fail-on: high
```

Get an API key in [Console → Settings](https://radar.offseq.com/console) and save it as the `RADAR_API_KEY` repository secret.

With no `file` or `files`, the action scans every supported file tracked in the repository. On a pull request it fetches the base commit and sends each file with its state: unchanged, changed (with the base version) or added. Radar matches the packages the pull request adds or removes, so a finding is **new** only when the pull request brings in a vulnerable package, and **fixed** when it removes or upgrades one. A version bump that still leaves the same CVE open is not new.

The checkout must be the pull request head or its merge commit, which is what `actions/checkout` gives on `pull_request`. Under `pull_request_target` it checks out the base branch, so check out `${{ github.event.pull_request.head.sha }}` there; otherwise the step fails rather than comparing the base with itself. Symlinked files are never read.

Fork and Dependabot pull requests get no secrets; there an empty key skips the scan with a warning. Their token is read-only, so the comment is skipped with a warning too. Anywhere else an empty key fails the step.

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | – | Radar API key. |
| `file` | – | A single SBOM or lockfile to scan. |
| `files` | – | Newline-separated paths or globs (`*`, `**`, `?`) to scan, relative to the workspace. Leave `file` and `files` empty to discover files. |
| `fail-on` | from config | `critical`, `high`, `medium`, `low`, `kev`, `exploited` or `act-now`. Only version-confirmed, unsuppressed findings count. Empty with no config value never fails. |
| `gate` | from config, else `new` on pull requests and `all` otherwise | `new` counts only findings the pull request introduces; `all` counts every finding. |
| `fail-on-incomplete` | `true` | Fail when the gate could not evaluate every package. The job summary lists them. |
| `config` | `.github/radar.yml` | Radar config in the repository. |
| `comment` | `true` on pull requests | Keep one comment on the pull request. Needs `pull-requests: write`. |
| `upload-sarif` | `true` | Upload SARIF to code scanning (category `offseq-radar`). Needs `security-events: write`. |
| `fix-prs` | `false` | Open fix pull requests for npm lockfiles. See [Fix pull requests](#fix-pull-requests). |
| `allow-major` | `false` | Let fix pull requests cross a semver major version. |
| `github-token` | `github.token` | Token for the comment and fix pull requests. |
| `api-url` | `https://radar.offseq.com` | Radar base URL. |

`fail-on` and `gate` set in the workflow override the config.

## Outputs

| Output | |
|---|---|
| `gate-tripped` | `true` when the gate matched a finding. |
| `gate-incomplete` | `true` when the gate could not evaluate every package. |
| `new-findings` | Findings the pull request introduces. |
| `resolved-findings` | Findings the pull request fixes. |
| `sarif-file` | Path of the SARIF report. |
| `comment-url` | URL of the pull request comment, when one was written. |
| `fix-prs` | JSON list of the fix pull request URLs opened or updated. |
| `skipped` | `true` when there was no API key or nothing to scan. |

## Pull request comment

The comment starts with a headline (for example *2 new vulnerabilities introduced by this PR (1 CISA KEV) · fixes 3 · 14 existing*), then a table of new findings, riskiest first, with the file and line, severity, KEV and EPSS, Radar's decision and the version to upgrade to. Fixed, existing and suppressed findings follow in collapsed sections.

The action keeps a single comment, marked `<!-- offseq-radar-scan -->`, and edits it on every push. A pull request that introduces and fixes nothing gets no comment; once a comment exists, it is updated to the clean state rather than deleted.

## Configuration: `.github/radar.yml`

```yaml
failOn: high              # critical | high | medium | low | kev | exploited | act-now
gate: new                 # new | all
ignore:
  - id: CVE-2024-1234     # CVE, GHSA or RADAR- id
    package: pkg:npm/lodash   # optional, versionless purl prefix
    reason: not reachable     # required
    until: 2027-01-01         # optional; expired entries stop applying
paths:
  exclude: ["examples/**", "test/fixtures/**"]
fixes:
  enabled: true
  allowMajor: false
  overrides: false        # allow npm overrides for transitive dependencies
  maxOpen: 5
```

Radar validates the file and rejects unknown keys or invalid values with a precise message, which fails the step. Ignored findings and findings you marked as not exploitable in the Radar console stay in the report as suppressed, never count towards the gate, and carry a SARIF suppression so code scanning shows them as dismissed.

On pull requests the config is always read from the **base** commit, so a pull request cannot loosen its own gate or ignore its own findings. Config changes take effect once merged. On other events the checked-out commit's config is used.

The action reads `paths.exclude` itself to skip files during discovery. It understands block lists and `[...]` lists under `paths:`; anything else excludes nothing, so a config it cannot read scans more, never less.

## Supported files

Discovery looks for `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `go.mod`, `go.sum`, `composer.lock`, `Gemfile.lock`, `requirements*.txt`, `*.cdx.json`, `bom.json` and `*.spdx.json`, skipping `node_modules/`, `vendor/` and `.git/`. Where a directory has both `go.mod` and `go.sum`, only `go.mod` is scanned, because it marks indirect dependencies. Up to 50 files go in one request; narrow `files` or add `paths.exclude` for more.

A file that is not tracked in git, such as an SBOM generated during the job, has no base version, so on pull requests all its findings count as new; use `gate: all` for those.

Through `file` or `files` you can also scan CycloneDX XML, SPDX tag-value and purl-per-line lists. The format is detected from the file name, then the content.

The number of packages per scan follows your plan's batch cap; see [pricing](https://radar.offseq.com/pricing). On pull requests, the packages the pull request adds or removes are always checked; unchanged packages are checked too when the total fits the cap, and the report says when they were not.

## Fix pull requests

On paid plans the action can open one pull request per npm lockfile directory that upgrades vulnerable packages. It runs on `push`, `schedule` and `workflow_dispatch` on the default branch only, and never pushes to the default branch.

```yaml
name: Radar fixes
on:
  push:
    branches: [main]
  schedule:
    - cron: '17 6 * * 1-5'
  workflow_dispatch:

permissions:
  contents: write          # push the fix branches
  pull-requests: write     # open the pull requests
  security-events: write

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: offseq/radar-scan-action@v2
        with:
          api-key: ${{ secrets.RADAR_API_KEY }}
          fix-prs: true
```

For each `package-lock.json` with a `package.json` beside it, Radar plans the upgrades. The action then:

1. rewrites direct dependency ranges in `package.json`, keeping its indentation and range prefix (`^`, `~` or exact), and adds `overrides` when the config allows them;
2. runs `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, then `npm update <name> --package-lock-only --ignore-scripts` for transitive packages;
3. checks the new lockfile and drops any upgrade npm did not resolve to the planned version or later;
4. force-pushes the result to `offseq-radar/fix/<directory>` and opens or updates the pull request *Radar: fix N vulnerabilities in &lt;dir&gt;/package-lock.json*, listing each upgrade with its CVEs, CISA KEV and exploitation flags, major upgrades and what was left out.

Major upgrades are skipped unless `allow-major: true`. No install scripts run. On a free plan the step warns and carries on.

GitHub does not start workflows for pushes and pull requests made with the default `GITHUB_TOKEN`, so your checks will not run on fix pull requests by themselves. To have them run, check out with a GitHub App token or a fine-grained token and pass it as `github-token` too. If the repository does not allow GitHub Actions to create pull requests (Settings → Actions → General → Workflow permissions), the branch is pushed and the step warns.

## Migrating from v1

- `file` is optional: without it the action discovers every supported file. Keep `file` to scan exactly one.
- On pull requests the gate counts only **new** findings (`gate: new`). Set `gate: all` to keep v1's behaviour of failing on any finding in the file.
- A pull request comment is written by default; add `pull-requests: write` to the job permissions or set `comment: false`.
- SARIF alerts now point at the package's line in the lockfile instead of line 1 and use a version-independent fingerprint. Existing code-scanning alerts are closed and reopened once under the new key after upgrading; after that they stay stable across version bumps.
- `fail-on` accepts `act-now`.

`@v1` stays as it is and keeps v1's behaviour.

## Without the Action

```sh
jq -n --rawfile content package-lock.json '{files: [{content: $content, filename: "package-lock.json"}]}' |
  curl -sS "https://radar.offseq.com/api/v1/scan?failOn=high" \
    -H "X-API-Key: $RADAR_API_KEY" -H "Content-Type: application/json" --data-binary @-
```

## Versioning

`@v2` follows the latest `v2.x.y` release; pin a full tag such as `@v2.0.0` or a commit SHA for reproducible builds.

## Development

```sh
node --test test/*.test.mjs
shellcheck scripts/*.sh
```

## License

[MIT](LICENSE)
