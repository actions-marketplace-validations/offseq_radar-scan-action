import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScript, stubBin, tmp } from './helpers.mjs';

const LIST = 'api --paginate repos/acme/app/issues/7/comments';
const MARKER = '<!-- offseq-radar-scan -->\n';

function report(data, markdown = 'report body\n') {
  const path = join(tmp(), 'report.json');
  writeFileSync(path, JSON.stringify({ data, markdown }));
  return path;
}
const dirty = () => report({ summary: { new: 1, resolved: 0 }, gate: { tripped: false, incomplete: false } });
const clean = () => report({ summary: { new: 0, resolved: 0 }, gate: { tripped: false, incomplete: false } }, 'all clear\n');

const run = (gh, env) => runScript('comment.sh', { cwd: tmp(), path: gh.dir, env: { GH_TOKEN: 't', RADAR_PR: '7', ...env } });

test('creates the comment when the pull request has findings', async () => {
  const gh = stubBin([
    { match: LIST, stdout: '' },
    { match: '-X POST repos/acme/app/issues/7/comments', stdout: 'https://github.com/acme/app/pull/7#issuecomment-1\n' }
  ]);
  const r = await run(gh, { RADAR_REPORT: dirty() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const calls = gh.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--jq'));
  assert.deepEqual(JSON.parse(calls[1].input), { body: `${MARKER}report body\n` });
  assert.equal(r.outputs['comment-url'], 'https://github.com/acme/app/pull/7#issuecomment-1');
});

test('a clean pull request without an earlier comment gets none', async () => {
  const gh = stubBin([{ match: LIST, stdout: '' }]);
  const r = await run(gh, { RADAR_REPORT: clean() });
  assert.equal(r.code, 0);
  assert.equal(gh.calls().length, 1);
  assert.equal(r.outputs['comment-url'], undefined);
});

test('an earlier comment is updated in place, also to the clean state', async () => {
  const gh = stubBin([
    { match: LIST, stdout: '111\n222\n' },
    { match: '-X PATCH repos/acme/app/issues/comments/111 ', stdout: 'https://github.com/acme/app/pull/7#issuecomment-111\n' }
  ]);
  const r = await run(gh, { RADAR_REPORT: clean() });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(gh.calls()[1].input).body, `${MARKER}all clear\n`);
  assert.equal(r.outputs['comment-url'], 'https://github.com/acme/app/pull/7#issuecomment-111');
});

test('the lookup trusts only bot or maintainer comments', async () => {
  const gh = stubBin([{ match: LIST, stdout: '' }]);
  await run(gh, { RADAR_REPORT: clean() });
  const jq = gh.calls()[0].args.at(-1);
  assert.match(jq, /startswith\("<!-- offseq-radar-scan -->"\)/);
  assert.match(jq, /\.user\.type == "Bot" or \(\.author_association \| IN\("OWNER", "MEMBER", "COLLABORATOR"\)\)/);
});

test('a read-only token warns instead of failing', async () => {
  const gh = stubBin([
    { match: LIST, stdout: '' },
    { match: '-X POST', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n', code: 1 }
  ]);
  const r = await run(gh, { RADAR_REPORT: dirty() });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /::warning::Cannot write the pull request comment \(HTTP 403\)/);
});

test('other API errors fail the step', async () => {
  const gh = stubBin([{ match: LIST, stderr: 'gh: Server Error (HTTP 502)\n', code: 1 }]);
  const r = await run(gh, { RADAR_REPORT: dirty() });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::GitHub API: gh: Server Error \(HTTP 502\)/);
});

test('an oversized report is truncated below the comment limit', async () => {
  const gh = stubBin([{ match: LIST, stdout: '' }, { match: '-X POST', stdout: 'u\n' }]);
  await run(gh, { RADAR_REPORT: report({ summary: { new: 1 } }, 'x'.repeat(70000)) });
  const body = JSON.parse(gh.calls()[1].input).body;
  assert.ok(body.length <= 65536);
  assert.match(body, /truncated\. See the job summary/);
});

test('rejects a non-numeric pull request number', async () => {
  const gh = stubBin([]);
  const r = await run(gh, { RADAR_PR: '1;id', RADAR_REPORT: dirty() });
  assert.equal(r.code, 1);
});
