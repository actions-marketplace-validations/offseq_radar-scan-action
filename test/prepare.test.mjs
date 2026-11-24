import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepare } from '../scripts/prepare.mjs';
import { commit, repo, tmp, write } from './helpers.mjs';

const opts = (cwd, extra = {}) => ({ cwd, file: '', files: '', config: '.github/radar.yml', baseSha: '', ...extra });

test('classifies files against the base and reads the config from the base only', () => {
  const root = repo();
  const base = commit(root, {
    'package-lock.json': 'lock v1',
    'svc/go.mod': 'module a',
    'examples/yarn.lock': 'demo',
    '.github/radar.yml': 'paths:\n  exclude: ["examples/**"]\n'
  });
  commit(root, {
    'package-lock.json': 'lock v2',
    'web/pnpm-lock.yaml': 'new',
    '.github/radar.yml': 'failOn: low\n'
  });
  const { body, files } = prepare(opts(root, { baseSha: base }));
  assert.deepEqual(files, [
    { filename: 'package-lock.json', mode: 'changed' },
    { filename: 'svc/go.mod', mode: 'unchanged' },
    { filename: 'web/pnpm-lock.yaml', mode: 'new' }
  ]);
  assert.equal(body.config, 'paths:\n  exclude: ["examples/**"]\n');
  assert.deepEqual(body.files[0], { content: 'lock v2', filename: 'package-lock.json', base: { content: 'lock v1' } });
  assert.deepEqual(body.files[1], { content: 'module a', filename: 'svc/go.mod', unchanged: true });
  assert.deepEqual(body.files[2], { content: 'new', filename: 'web/pnpm-lock.yaml', isNew: true });
});

test('a config added by the pull request is ignored', () => {
  const root = repo();
  const base = commit(root, { 'yarn.lock': 'a' });
  commit(root, { '.github/radar.yml': 'paths:\n  exclude: ["**"]\n' });
  const { body, files } = prepare(opts(root, { baseSha: base }));
  assert.equal(body.config, undefined);
  assert.deepEqual(files, [{ filename: 'yarn.lock', mode: 'unchanged' }]);
});

test('without a base, files are sent whole with the working-tree config', () => {
  const root = repo();
  commit(root, { 'Cargo.lock': 'c', '.github/radar.yml': 'gate: all\n' });
  const { body } = prepare(opts(root));
  assert.deepEqual(body, { files: [{ content: 'c', filename: 'Cargo.lock' }], config: 'gate: all\n' });
});

test('explicit file and globs resolve against the working directory', () => {
  const root = repo();
  commit(root, { 'apps/a/bom.xml': 'x', 'apps/b/sbom.cdx.json': '{}', 'apps/c/other.txt': 'o' });
  const sub = join(root, 'apps');
  assert.deepEqual(prepare(opts(sub, { file: 'a/bom.xml', files: 'b/*.json\n\n' })).files.map(f => f.filename),
    ['apps/a/bom.xml', 'apps/b/sbom.cdx.json']);
  assert.throws(() => prepare(opts(root, { file: 'missing.lock' })), /File not found: missing.lock/);
  assert.throws(() => prepare(opts(root, { files: 'nothing/**' })), /No tracked file matches nothing\/\*\*/);
  assert.throws(() => prepare(opts(sub, { file: '../../etc' })), /outside the repository|File not found/);
  assert.throws(() => prepare(opts(root, { config: '../x.yml' })), /inside the repository/);
});

test('an untracked new file is not discovered, and more than 50 files is refused', () => {
  const root = repo();
  commit(root, { 'uv.lock': 'u' });
  write(root, { 'poetry.lock': 'untracked' });
  assert.deepEqual(prepare(opts(root)).files.map(f => f.filename), ['uv.lock']);
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`p${i}/yarn.lock`, 'y']));
  commit(root, many);
  assert.throws(() => prepare(opts(root)), /53 files to scan, more than 50/);
});

test('fails outside a git checkout', () => {
  assert.throws(() => prepare(opts(tmp())));
});
