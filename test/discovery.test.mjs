import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, isScannable, matcher, pickFiles } from '../scripts/discovery.mjs';
import { readExclude } from '../scripts/config.mjs';

test('isScannable knows the supported names', () => {
  for (const p of ['package-lock.json', 'a/npm-shrinkwrap.json', 'yarn.lock', 'x/pnpm-lock.yaml', 'poetry.lock', 'uv.lock',
    'Cargo.lock', 'go.mod', 'go.sum', 'composer.lock', 'Gemfile.lock', 'requirements.txt', 'requirements-dev.txt',
    'sbom/app.cdx.json', 'bom.json', 'app.spdx.json']) assert.ok(isScannable(p), p);
  for (const p of ['package.json', 'Cargo.toml', 'reqs.txt', 'bom.xml', 'lock.json']) assert.ok(!isScannable(p), p);
});

test('pickFiles skips vendored trees, prefers go.mod and applies excludes', () => {
  const paths = [
    'package-lock.json', 'node_modules/x/package-lock.json', 'vendor/a/go.sum', 'svc/go.mod', 'svc/go.sum',
    'tools/go.sum', 'evil\n::error::x/yarn.lock', 'examples/demo/yarn.lock', 'test/fixtures/poetry.lock', 'web/pnpm-lock.yaml', 'README.md'
  ];
  assert.deepEqual(pickFiles(paths, { exclude: ['examples/**', 'test/fixtures/'] }),
    ['package-lock.json', 'svc/go.mod', 'tools/go.sum', 'web/pnpm-lock.yaml']);
});

test('globToRegExp handles *, ** and ?', () => {
  assert.ok(globToRegExp('**/fixtures/**').test('a/b/fixtures/c/yarn.lock'));
  assert.ok(globToRegExp('**/fixtures/**').test('fixtures/yarn.lock'));
  assert.ok(globToRegExp('apps/*/package-lock.json').test('apps/web/package-lock.json'));
  assert.ok(!globToRegExp('apps/*/package-lock.json').test('apps/web/x/package-lock.json'));
  assert.ok(globToRegExp('requirements?.txt').test('requirements2.txt'));
  assert.ok(globToRegExp('docs').test('docs/a/uv.lock'));
  assert.ok(!globToRegExp('docs').test('docsite/uv.lock'));
  assert.ok(!globToRegExp('a.b').test('axb'));
  assert.ok(matcher(['./web/**'])('web/yarn.lock'));
});

test('readExclude reads block and flow lists and JSON', () => {
  assert.deepEqual(readExclude('failOn: high\npaths:\n  exclude:\n    - "examples/**"   # demo\n    - test/fixtures/**\nfixes:\n  enabled: true\n'),
    ['examples/**', 'test/fixtures/**']);
  assert.deepEqual(readExclude('paths:\n  exclude:\n  - a/**\n  other: 1\n'), ['a/**']);
  assert.deepEqual(readExclude("paths:\n  # note\n  exclude: ['a/**', \"b/**\"]\n"), ['a/**', 'b/**']);
  assert.deepEqual(readExclude('{"paths":{"exclude":["x/**"]}}'), ['x/**']);
});

test('readExclude excludes nothing when it cannot read the config', () => {
  for (const text of ['', null, 'failOn: high\n', 'paths: {exclude: [a]}\n', 'paths:\n  exclude: [a,\n    b]\n', 'paths:\n  exclude: a/**\n', '{"paths":{"exclude":"a"}}'])
    assert.deepEqual(readExclude(text), [], String(text));
});
