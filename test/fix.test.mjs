import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyManifestPatch, compareVersions, describe, filterMajors, installed, isResolved, parseVersion, verify } from '../scripts/fix.mjs';

const cmp = (a, b) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)));

test('compareVersions follows semver precedence', () => {
  assert.equal(cmp('1.2.3', '1.2.3'), 0);
  assert.equal(cmp('1.10.0', '1.9.9'), 1);
  assert.equal(cmp('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(cmp('2.0.0-alpha.10', '2.0.0-alpha.9'), 1);
  assert.equal(cmp('2.0.0-alpha', '2.0.0-alpha.1'), -1);
  assert.equal(cmp('2.0.0-beta', '2.0.0-alpha.1'), 1);
  assert.equal(cmp('v1.0.0+build', '1.0.0'), 0);
  assert.equal(parseVersion('latest'), null);
});

const plan = {
  plan: [
    { name: 'lodash', from: '4.17.15', to: '4.17.21', direct: true, major: false, strategy: 'bump', findings: ['CVE-2021-23337'] },
    { name: 'minimist', from: '0.0.8', to: '1.2.6', direct: false, major: true, strategy: 'override', findings: ['CVE-2021-44906'] },
    { name: '@scope/x', from: '1.0.0', to: '2.0.0', direct: true, major: true, strategy: 'bump', findings: ['GHSA-aaaa'] }
  ],
  skipped: [{ name: 'git-dep', reason: 'not a registry dependency' }],
  manifestPatch: {
    dependencies: { lodash: '^4.17.21', '@scope/x': '^2.0.0' },
    devDependencies: {},
    overrides: { 'minimist@0': '1.2.6', minimistic: '1.0.0' }
  }
};

test('filterMajors drops major upgrades and their manifest keys unless allowed', () => {
  const out = filterMajors(plan, false);
  assert.deepEqual(out.plan.map(p => p.name), ['lodash']);
  assert.deepEqual(out.manifestPatch, { dependencies: { lodash: '^4.17.21' }, devDependencies: {}, overrides: { minimistic: '1.0.0' } });
  assert.deepEqual(out.skipped.map(s => s.name), ['git-dep', 'minimist', '@scope/x']);
  assert.match(out.skipped[1].reason, /allow-major/);
  assert.equal(plan.manifestPatch.overrides['minimist@0'], '1.2.6');
  assert.equal(filterMajors(plan, true).plan.length, 3);
  assert.deepEqual(filterMajors({}, false), { plan: [], skipped: [], manifestPatch: {} });
});

test('applyManifestPatch keeps indentation, key order and the trailing newline', () => {
  const tabs = '{\n\t"name": "a",\n\t"dependencies": {\n\t\t"lodash": "^4.17.15",\n\t\t"zod": "3.0.0"\n\t}\n}\n';
  assert.equal(applyManifestPatch(tabs, { dependencies: { lodash: '^4.17.21' }, devDependencies: {} }),
    '{\n\t"name": "a",\n\t"dependencies": {\n\t\t"lodash": "^4.17.21",\n\t\t"zod": "3.0.0"\n\t}\n}\n');
  const four = '{\r\n    "name": "a",\r\n    "devDependencies": { "x": "~1.0.0" }\r\n}';
  assert.equal(applyManifestPatch(four, { devDependencies: { x: '~1.0.5' }, overrides: { 'y@1': '1.2.0' } }),
    '{\r\n    "name": "a",\r\n    "devDependencies": {\r\n        "x": "~1.0.5"\r\n    },\r\n    "overrides": {\r\n        "y@1": "1.2.0"\r\n    }\r\n}');
  assert.equal(applyManifestPatch('{"a":1}', {}), '{\n  "a": 1\n}');
});

const v3 = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { lodash: '^4.17.21' } },
    'node_modules/lodash': { version: '4.17.21' },
    'node_modules/minimist': { version: '1.2.8' },
    'node_modules/a/node_modules/minimist': { version: '0.0.10' },
    'node_modules/b/node_modules/minimist': { version: '1.2.5' },
    'node_modules/linked': { link: true, resolved: 'packages/linked' },
    'packages/linked': { version: '1.0.0' }
  }
};
const v1 = {
  lockfileVersion: 1,
  dependencies: {
    lodash: { version: '4.17.20' },
    a: { version: '1.0.0', dependencies: { lodash: { version: '3.10.1' } } }
  }
};

test('installed lists every copy in v2/v3 and nested v1 lockfiles', () => {
  assert.deepEqual(installed(v3, 'minimist').map(c => c.path), ['node_modules/minimist', 'node_modules/a/node_modules/minimist', 'node_modules/b/node_modules/minimist']);
  assert.deepEqual(installed(v3, 'linked'), []);
  assert.deepEqual(installed(v1, 'lodash'), [{ path: 'node_modules/lodash', version: '4.17.20' }, { path: 'node_modules/a/node_modules/lodash', version: '3.10.1' }]);
});

test('isResolved checks the top level for bumps and every copy on the vulnerable major otherwise', () => {
  assert.ok(isResolved(v3, { name: 'lodash', from: '4.17.15', to: '4.17.21', strategy: 'bump' }));
  assert.ok(!isResolved(v1, { name: 'lodash', from: '4.17.15', to: '4.17.21', strategy: 'bump' }));
  assert.ok(!isResolved(v3, { name: 'minimist', from: '1.2.0', to: '1.2.6', strategy: 'update' }));
  assert.ok(isResolved(v3, { name: 'minimist', from: '1.2.0', to: '1.2.5', strategy: 'update' }));
  assert.ok(!isResolved(v3, { name: 'minimist', from: '0.0.8', to: '0.2.4', strategy: 'override' }));
  assert.ok(isResolved(v3, { name: 'gone', from: '1.0.0', to: '1.0.1', strategy: 'update' }));
  assert.ok(!isResolved(v3, { name: 'minimist', from: 'garbage', to: '1.2.6', strategy: 'update' }));
});

test('verify keeps resolved items and reports the rest', () => {
  const out = verify(v3, {
    plan: [{ name: 'lodash', from: '4.17.15', to: '4.17.21', strategy: 'bump' }, { name: 'minimist', from: '1.2.0', to: '1.2.6', strategy: 'update' }],
    skipped: [],
    manifestPatch: {}
  });
  assert.deepEqual(out.plan.map(p => p.name), ['lodash']);
  assert.deepEqual(out.skipped, [{ name: 'minimist', reason: 'npm did not resolve 1.2.6 or later' }]);
});

test('describe titles by unique vulnerabilities and flags KEV, exploited and majors', () => {
  const report = {
    data: {
      findings: [
        { purl: 'pkg:npm/lodash@4.17.15', cveId: 'CVE-2021-23337', kev: true, exploited: true, file: 'web/package-lock.json' },
        { purl: 'pkg:npm/%40scope/x@1.0.0', id: '42', kev: false, exploited: true, file: 'web/package-lock.json' },
        { purl: 'pkg:npm/lodash@4.17.15', cveId: 'CVE-2020-8203', kev: true, file: 'other/package-lock.json' }
      ]
    }
  };
  const { title, body } = describe({
    plan: [
      { name: 'lodash', from: '4.17.15', to: '4.17.21', direct: true, strategy: 'bump', findings: ['CVE-2021-23337', 'CVE-2020-8203'] },
      { name: '@scope/x', from: '1.0.0', to: '2.0.0', direct: false, major: true, strategy: 'override', findings: ['RADAR-42', 'CVE-2021-23337'] }
    ],
    skipped: [{ name: 'evil|`name`', reason: 'line\nbreak' }]
  }, { lockfile: 'web/package-lock.json', report });
  assert.equal(title, 'Radar: fix 3 vulnerabilities in web/package-lock.json');
  assert.match(body, /\| `lodash` \| 4\.17\.15 \| 4\.17\.21 \| CVE-2021-23337, CVE-2020-8203 \| CISA KEV, exploited, direct \|/);
  assert.match(body, /\| `@scope\/x` \| 1\.0\.0 \| 2\.0\.0 \| RADAR-42, CVE-2021-23337 \| exploited, major, transitive \|/);
  assert.ok(body.includes('- `evil\\| name `: line break'));
  assert.match(body, /Opened by the \[OffSeq Radar Action\]/);
  assert.equal(describe({ plan: [{ name: 'a', findings: ['CVE-1'] }], skipped: [] }, { lockfile: 'package-lock.json' }).title,
    'Radar: fix 1 vulnerability in package-lock.json');
});
