import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, mockRadar, repo, runScript, stubBin, tmp } from './helpers.mjs';

const MANIFEST = '{\n    "name": "web",\n    "dependencies": {\n        "lodash": "^4.17.15"\n    }\n}\n';
const lock = (lodash, qs) => JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { lodash: '^4.17.15' } },
    'node_modules/lodash': { version: lodash },
    'node_modules/body/node_modules/qs': { version: qs }
  }
}, null, 2) + '\n';

const PLAN = {
  plan: [
    { name: 'lodash', from: '4.17.15', to: '4.17.21', direct: true, major: false, strategy: 'bump', findings: ['CVE-2021-23337'] },
    { name: 'qs', from: '6.5.2', to: '6.5.3', direct: false, major: false, strategy: 'update', findings: ['CVE-2022-24999'] },
    { name: 'minimist', from: '0.0.8', to: '1.2.6', direct: false, major: true, strategy: 'override', findings: ['CVE-2021-44906'] }
  ],
  skipped: [{ name: 'local-thing', reason: 'file: dependency' }],
  manifestPatch: { dependencies: { lodash: '^4.17.21' }, overrides: { 'minimist@0': '1.2.6' } }
};

async function setup({ planRoute = { status: 200, body: PLAN }, resolvedQs = '6.5.3', prList = '' } = {}) {
  const remote = tmp();
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const root = repo();
  const start = commit(root, { 'web/package.json': MANIFEST, 'web/package-lock.json': lock('4.17.15', '6.5.2'), '.github/radar.yml': 'fixes:\n  enabled: true\n' });
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  const scratch = tmp();
  const files = join(scratch, 'files.json');
  writeFileSync(files, JSON.stringify({ files: [{ filename: 'web/package-lock.json', mode: 'full' }, { filename: 'yarn.lock', mode: 'full' }] }));
  const report = join(scratch, 'report.json');
  writeFileSync(report, JSON.stringify({ data: { findings: [{ purl: 'pkg:npm/lodash@4.17.15', cveId: 'CVE-2021-23337', kev: true, exploited: true, file: 'web/package-lock.json' }] } }));
  writeFileSync(join(scratch, 'new-lock.json'), lock('4.17.21', resolvedQs));
  const radar = await mockRadar({ '/api/v1/fix/plan': planRoute });
  const bin = stubBin([
    { match: '^gh api repos/acme/app --jq .default_branch$', stdout: 'main\n' },
    { match: '^gh pr list', stdout: prList },
    { match: '^gh pr create', stdout: 'https://github.com/acme/app/pull/9\n' },
    { match: '^gh pr edit', stdout: '' },
    { match: '^npm install --package-lock-only --ignore-scripts --no-audit --no-fund$', copy: [join(scratch, 'new-lock.json'), join(root, 'web/package-lock.json')] },
    { match: '^npm update qs --package-lock-only --ignore-scripts', stdout: '' }
  ]);
  const env = {
    GH_TOKEN: 't', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', RADAR_API_KEY: 'k', RADAR_URL: radar.url,
    RADAR_CONFIG: '.github/radar.yml', RADAR_ALLOW_MAJOR: 'false', RADAR_FILES: files, RADAR_REPORT: report
  };
  return { root, remote, start, radar, bin, env };
}

test('opens one fix PR per npm lockfile from the default branch without touching it', async () => {
  const { root, remote, start, radar, bin, env } = await setup();
  const r = await runScript('fix-prs.sh', { cwd: root, path: bin.dir, env });
  radar.close();
  assert.equal(r.code, 0, r.stdout + r.stderr);

  const [req] = radar.requests;
  assert.equal(req.headers['x-api-key'], 'k');
  assert.deepEqual(Object.keys(req.body).sort(), ['allowMajor', 'config', 'filename', 'lockfile', 'manifest']);
  assert.equal(req.body.allowMajor, false);
  assert.equal(req.body.filename, 'web/package-lock.json');
  assert.equal(req.body.config, 'fixes:\n  enabled: true\n');

  assert.equal(git(remote, 'rev-parse', 'main'), start);
  const branch = 'offseq-radar/fix/web';
  assert.equal(git(remote, 'rev-parse', `${branch}^`), start);
  assert.equal(git(remote, 'log', '-1', '--format=%an <%ae>|%s', branch),
    'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>|Radar: fix 2 vulnerabilities in web/package-lock.json');
  const manifest = git(remote, 'show', `${branch}:web/package.json`);
  assert.match(manifest, /\n {8}"lodash": "\^4\.17\.21"\n/);
  assert.doesNotMatch(manifest, /minimist/);
  assert.match(git(remote, 'show', `${branch}:web/package-lock.json`), /"version": "4\.17\.21"/);

  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD'), start);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(root, 'web/package.json'), 'utf8'), MANIFEST);

  const create = bin.calls().find(c => c.bin === 'gh' && c.args[1] === 'create');
  assert.deepEqual(create.args.slice(0, 10), ['pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', branch, '--title', 'Radar: fix 2 vulnerabilities in web/package-lock.json']);
  const body = readFileSync(join(r.runner, 'radar-fix', 'body.md'), 'utf8');
  assert.match(body, /\| `lodash` \| 4\.17\.15 \| 4\.17\.21 \| CVE-2021-23337 \| CISA KEV, exploited, direct \|/);
  assert.match(body, /`minimist`: major upgrade to 1\.2\.6; set allow-major: true/);
  assert.match(body, /`local-thing`: file: dependency/);
  assert.deepEqual(JSON.parse(r.outputs['fix-prs']), ['https://github.com/acme/app/pull/9']);
});

test('an existing fix PR is updated and unresolved upgrades are dropped', async () => {
  const { root, radar, bin, env } = await setup({ resolvedQs: '6.5.2', prList: 'https://github.com/acme/app/pull/3\n' });
  const r = await runScript('fix-prs.sh', { cwd: root, path: bin.dir, env });
  radar.close();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const edit = bin.calls().find(c => c.bin === 'gh' && c.args[1] === 'edit');
  assert.deepEqual(edit.args.slice(0, 5), ['pr', 'edit', 'https://github.com/acme/app/pull/3', '--title', 'Radar: fix 1 vulnerability in web/package-lock.json']);
  assert.match(readFileSync(join(r.runner, 'radar-fix', 'body.md'), 'utf8'), /`qs`: npm did not resolve 6\.5\.3 or later/);
  assert.match(r.stdout, /Not fixed: qs: npm did not resolve 6\.5\.3 or later/);
  assert.deepEqual(JSON.parse(r.outputs['fix-prs']), ['https://github.com/acme/app/pull/3']);
});

test('a free plan warns without failing or pushing', async () => {
  const { root, remote, radar, bin, env } = await setup({ planRoute: { status: 403, body: { error: 'Paid plan required', message: 'Fix PRs need Pro.' } } });
  const r = await runScript('fix-prs.sh', { cwd: root, path: bin.dir, env });
  radar.close();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /::warning::Fix PRs need a paid Radar plan: Fix PRs need Pro\./);
  assert.equal(git(remote, 'branch', '--list', 'offseq-radar/*'), '');
  assert.deepEqual(JSON.parse(r.outputs['fix-prs']), []);
});

test('only runs on the default branch outside pull requests', async () => {
  const { root, radar, bin, env } = await setup();
  for (const extra of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }]) {
    const r = await runScript('fix-prs.sh', { cwd: root, path: bin.dir, env: { ...env, ...extra } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /fix-prs runs on/);
  }
  radar.close();
  assert.equal(radar.requests.length, 0);
});
