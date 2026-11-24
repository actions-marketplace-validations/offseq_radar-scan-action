import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commit, git, mockRadar, repo, runScript } from './helpers.mjs';

const REPORT = {
  success: true,
  data: {
    format: 'multiple',
    findings: [],
    resolved: [{ purl: 'pkg:npm/a@1.0.0' }],
    truncated: [{ purl: 'pkg:npm/big@1.0.0', reason: 'candidate-cap' }],
    summary: { total: 3, new: 2, resolved: 1 },
    gate: { failOn: 'high', scope: 'new', tripped: true, incomplete: false, counted: 2 }
  },
  markdown: '**2 new vulnerabilities** introduced by this PR\n',
  sarif: { version: '2.1.0', runs: [] }
};

const inputs = (url, extra = {}) => ({
  RADAR_API_KEY: 'secret-key', RADAR_FILE: '', RADAR_FILES: '', RADAR_FAIL_ON: '', RADAR_GATE: '', RADAR_FAIL_ON_INCOMPLETE: 'true',
  RADAR_CONFIG: '.github/radar.yml', RADAR_COMMENT: '', RADAR_UPLOAD: 'true', RADAR_FIX_PRS: 'false', RADAR_ALLOW_MAJOR: 'false',
  RADAR_URL: url, RADAR_BASE_SHA: '', RADAR_NO_SECRETS: 'false', ...extra
});

function prRepo() {
  const root = repo();
  const base = commit(root, { 'package-lock.json': '{"v":1}', 'go.mod': 'module a', '.github/radar.yml': 'failOn: high\n' });
  commit(root, { 'package-lock.json': '{"v":2}', 'web/yarn.lock': 'y' });
  git(root, 'remote', 'add', 'origin', root);
  return { root, base };
}

test('a pull request scan sends one diff request and reports the new findings', async () => {
  const radar = await mockRadar({ '/api/v1/scan': { status: 200, body: REPORT } });
  const { root, base } = prRepo();
  const r = await runScript('scan.sh', { cwd: root, env: inputs(radar.url, { RADAR_BASE_SHA: base }) });
  radar.close();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(radar.requests.length, 1);
  const [req] = radar.requests;
  assert.deepEqual(req.query, { format: 'all' });
  assert.equal(req.headers['x-api-key'], 'secret-key');
  assert.deepEqual(req.body.files.map(f => [f.filename, f.isNew ?? f.unchanged ?? f.base?.content]),
    [['go.mod', true], ['package-lock.json', '{"v":1}'], ['web/yarn.lock', true]]);
  assert.equal(req.body.config, 'failOn: high\n');
  assert.equal(r.outputs['gate-tripped'], 'true');
  assert.equal(r.outputs['gate-incomplete'], 'false');
  assert.equal(r.outputs['new-findings'], '2');
  assert.equal(r.outputs['resolved-findings'], '1');
  assert.equal(JSON.parse(readFileSync(r.outputs['sarif-file'], 'utf8')).version, '2.1.0');
  assert.deepEqual(JSON.parse(readFileSync(r.outputs.files, 'utf8')).files.map(f => f.mode), ['unchanged', 'changed', 'new']);
  assert.match(r.summary, /\*\*2 new vulnerabilities\*\*/);
  assert.match(r.summary, /1 package\(s\) not fully evaluated: `pkg:npm\/big@1.0.0` \(candidate-cap\)/);
  assert.match(r.stdout, /go\.mod \(unchanged\), package-lock\.json \(changed\), web\/yarn\.lock \(new\)/);
  assert.ok(!(r.stdout + r.stderr).includes('secret-key'));
});

test('explicit fail-on and gate win over the config through the query', async () => {
  const radar = await mockRadar({ '/api/v1/scan': { status: 200, body: { data: { summary: {} }, markdown: '', sarif: {} } } });
  const { root } = prRepo();
  const r = await runScript('scan.sh', { cwd: root, env: inputs(radar.url, { RADAR_FAIL_ON: 'act-now', RADAR_GATE: 'all', RADAR_FILE: 'go.mod', RADAR_UPLOAD: 'false' }) });
  radar.close();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(radar.requests[0].query, { format: 'all', failOn: 'act-now', gate: 'all' });
  assert.deepEqual(radar.requests[0].body.files.map(f => Object.keys(f)), [['content', 'filename']]);
  assert.equal(r.outputs['new-findings'], '0');
  assert.equal(r.outputs['resolved-findings'], '0');
  assert.equal(r.outputs['sarif-file'], undefined);
});

test('invalid inputs fail before any request', async () => {
  const radar = await mockRadar({});
  const { root } = prRepo();
  for (const [env, msg] of [
    [{ RADAR_GATE: 'changed' }, /gate must be new, all or empty/],
    [{ RADAR_FAIL_ON: 'severe' }, /fail-on must be/],
    [{ RADAR_COMMENT: 'yes' }, /comment must be true, false or empty/],
    [{ RADAR_FIX_PRS: '1' }, /fix-prs must be true or false/],
    [{ RADAR_URL: 'file:///etc/passwd' }, /api-url must start with https:\/\//],
    [{ RADAR_BASE_SHA: 'main; rm -rf /' }, /Unexpected base SHA/],
    [{ RADAR_FILE: 'nope.lock' }, /File not found: nope.lock/]
  ]) {
    const r = await runScript('scan.sh', { cwd: root, env: inputs(radar.url, env) });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.stdout, msg);
  }
  radar.close();
  assert.equal(radar.requests.length, 0);
});

test('server errors surface their message', async () => {
  const radar = await mockRadar({ '/api/v1/scan': { status: 400, body: { error: 'Invalid input', message: 'config: ignore[0].reason is required\n::warning::x' } } });
  const { root } = prRepo();
  const r = await runScript('scan.sh', { cwd: root, env: inputs(radar.url) });
  radar.close();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::Radar scan failed \(HTTP 400\): config: ignore\[0\]\.reason is required ::warning::x$/m);
});

test('an empty key skips only where secrets are withheld', async () => {
  const { root } = prRepo();
  const skipped = await runScript('scan.sh', { cwd: root, env: inputs('http://127.0.0.1:9', { RADAR_API_KEY: '', RADAR_NO_SECRETS: 'true' }) });
  assert.equal(skipped.code, 0);
  assert.equal(skipped.outputs.skipped, 'true');
  const failed = await runScript('scan.sh', { cwd: root, env: inputs('http://127.0.0.1:9', { RADAR_API_KEY: '' }) });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /api-key is empty/);
});

test('a repository without supported files skips with a warning', async () => {
  const root = repo();
  commit(root, { 'README.md': 'x' });
  const r = await runScript('scan.sh', { cwd: root, env: inputs('http://127.0.0.1:9') });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.skipped, 'true');
  assert.match(r.stdout, /::warning::No supported lockfile or SBOM/);
});
