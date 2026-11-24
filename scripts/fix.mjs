import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  return m ? { nums: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : [] } : null;
}

const cmpIdent = (a, b) => {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = cmpIdent(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
}

const gte = (v, to) => {
  const a = parseVersion(v), b = parseVersion(to);
  return !!a && !!b && compareVersions(a, b) >= 0;
};

const ownsKey = (name, key) => key === name || key.startsWith(`${name}@`);

export function filterMajors(response, allowMajor) {
  const result = Array.isArray(response?.plan) ? response : response?.data;
  if (!Array.isArray(result?.plan)) throw new Error('The fix plan response has no plan');
  const { plan } = result;
  const skipped = [...(result.skipped ?? [])];
  const patch = structuredClone(result.manifestPatch ?? {});
  if (allowMajor) return { plan, skipped, manifestPatch: patch };
  const majors = plan.filter(p => p.major);
  for (const p of majors) {
    skipped.push({ name: p.name, reason: `major upgrade to ${p.to}; set allow-major: true to include it` });
    for (const section of Object.values(patch)) {
      if (section && typeof section === 'object') for (const key of Object.keys(section)) if (ownsKey(p.name, key)) delete section[key];
    }
  }
  return { plan: plan.filter(p => !p.major), skipped, manifestPatch: patch };
}

export function applyManifestPatch(text, patch) {
  const pkg = JSON.parse(text);
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [section, entries] of Object.entries(patch ?? {})) {
    if (!entries || typeof entries !== 'object' || !Object.keys(entries).length) continue;
    pkg[section] = { ...(pkg[section] ?? {}), ...entries };
  }
  const out = JSON.stringify(pkg, null, indent).replace(/\n/g, eol);
  return /\r?\n$/.test(text) ? out + eol : out;
}

const nameFromPath = path => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

export function installed(lock, name) {
  if (lock.packages) {
    return Object.entries(lock.packages)
      .filter(([path, p]) => path.includes('node_modules/') && nameFromPath(path) === name && !p.link)
      .map(([path, p]) => ({ path, version: p.version }));
  }
  const out = [];
  const walk = (deps, prefix) => {
    for (const [n, d] of Object.entries(deps ?? {})) {
      const path = `${prefix}node_modules/${n}`;
      if (n === name) out.push({ path, version: d.version });
      walk(d.dependencies, `${path}/`);
    }
  };
  walk(lock.dependencies, '');
  return out;
}

// A bumped direct dependency must resolve at the top level; for transitive fixes no copy on the
// vulnerable major may stay below the planned version.
export function isResolved(lock, item) {
  const copies = installed(lock, item.name);
  if (item.strategy === 'bump') {
    const top = copies.find(c => c.path === `node_modules/${item.name}`);
    return !!top && gte(top.version, item.to);
  }
  const major = parseVersion(item.from)?.nums[0];
  if (major === undefined) return false;
  return copies.every(c => parseVersion(c.version)?.nums[0] !== major || gte(c.version, item.to));
}

export function verify(lock, result) {
  const plan = [], skipped = [...result.skipped];
  for (const item of result.plan) {
    if (isResolved(lock, item)) plan.push(item);
    else skipped.push({ name: item.name, reason: `npm did not resolve ${item.to} or later` });
  }
  return { ...result, plan, skipped };
}

const vulnId = f => f.cveId || `RADAR-${f.id}`;
const npmName = purl => {
  const m = /^pkg:npm\/(.+)@[^@]+$/.exec(purl ?? '');
  return m ? decodeURIComponent(m[1]) : null;
};

const cell = v => String(v ?? '').replace(/[`\r\n]+/g, ' ').replace(/\|/g, '\\|');
const code = v => `\`${cell(v)}\``;

export function describe(result, { lockfile, report }) {
  const signals = new Map();
  for (const f of report?.data?.findings ?? []) {
    if (f.file && f.file !== lockfile) continue;
    const name = npmName(f.purl);
    if (name) signals.set(`${name}|${vulnId(f)}`, f);
  }
  const ids = new Set();
  const rows = result.plan.map(item => {
    const vulns = (item.findings ?? []).map(v => (typeof v === 'string' ? v : vulnId(v)));
    vulns.forEach(v => ids.add(v));
    const hits = vulns.map(v => signals.get(`${item.name}|${v}`)).filter(Boolean);
    const flags = [
      hits.some(f => f.kev) && 'CISA KEV',
      hits.some(f => f.exploited) && 'exploited',
      item.major && 'major',
      item.direct ? 'direct' : 'transitive'
    ].filter(Boolean);
    return `| ${code(item.name)} | ${cell(item.from)} | ${cell(item.to)} | ${cell(vulns.join(', '))} | ${flags.join(', ')} |`;
  });
  const title = `Radar: fix ${ids.size} ${ids.size === 1 ? 'vulnerability' : 'vulnerabilities'} in ${lockfile}`;
  const lines = [
    `OffSeq Radar found fixable vulnerabilities in ${code(lockfile)}.`, '',
    '| Package | From | To | Fixes | |', '|---|---|---|---|---|', ...rows
  ];
  if (result.skipped.length) {
    lines.push('', '**Not fixed here**', '', ...result.skipped.map(s => `- ${code(s.name)}: ${cell(s.reason)}`));
  }
  lines.push('', 'Opened by the [OffSeq Radar Action](https://github.com/offseq/radar-scan-action). Review the lockfile changes and run your tests before merging.');
  return { title, body: lines.join('\n') + '\n' };
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

const COMMANDS = {
  filter: (planFile, allowMajor) => process.stdout.write(JSON.stringify(filterMajors(readJson(planFile), allowMajor === 'true'))),
  apply: (manifest, planFile) => writeFileSync(manifest, applyManifestPatch(readFileSync(manifest, 'utf8'), readJson(planFile).manifestPatch)),
  verify: (lockfile, planFile) => process.stdout.write(JSON.stringify(verify(readJson(lockfile), readJson(planFile)))),
  describe: (planFile, lockfile, reportFile) =>
    process.stdout.write(JSON.stringify(describe(readJson(planFile), { lockfile, report: reportFile ? readJson(reportFile) : null })))
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    COMMANDS[cmd](...args);
  } catch (err) {
    console.error(`::error::${String(err.message).replace(/[\r\n]+/g, ' ')}`);
    process.exit(1);
  }
}
