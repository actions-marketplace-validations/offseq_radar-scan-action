import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTION = join(dirname(fileURLToPath(import.meta.url)), '..');

export const tmp = () => mkdtempSync(join(tmpdir(), 'radar-'));

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function repo(files = {}) {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  write(root, files);
  return root;
}

export function commit(root, files = {}, remove = []) {
  write(root, files);
  for (const p of remove) git(root, 'rm', '-q', '--', p);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'c');
  return git(root, 'rev-parse', 'HEAD');
}

// Replies with routes[path] = { status, body } and records every request.
export async function mockRadar(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: data ? JSON.parse(data) : null });
      const route = routes[url.pathname] ?? { status: 404, body: { error: 'Not found' } };
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(typeof route.body === 'function' ? route.body(requests.at(-1)) : route.body));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

// Fake `gh`/`npm` on PATH: rules [{ match: regex source, stdout?, stderr?, code?, run? }] tried in order.
export function stubBin(rules) {
  const dir = tmp();
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules));
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const i = args.indexOf('--input');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: require('path').basename(process.argv[1]), args, input: i === -1 ? null : fs.readFileSync(args[i + 1], 'utf8') }) + '\\n');
const line = require('path').basename(process.argv[1]) + ' ' + args.join(' ');
for (const r of JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'rules.json'))}, 'utf8'))) {
  if (!new RegExp(r.match).test(line)) continue;
  if (r.copy) fs.copyFileSync(r.copy[0], r.copy[1]);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code ?? 0);
}
process.stderr.write('unexpected call: ' + line + '\\n');
process.exit(97);
`;
  for (const bin of ['gh', 'npm']) {
    writeFileSync(join(dir, bin), script);
    chmodSync(join(dir, bin), 0o755);
  }
  return { dir, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
}

const parseOutputs = text => Object.fromEntries(text.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

export function runScript(script, { cwd, env, path }) {
  const runner = tmp();
  const output = join(runner, 'output');
  const summary = join(runner, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  return new Promise(resolve => {
    const child = spawn('bash', [join(ACTION, 'scripts', script)], {
      cwd,
      env: {
        PATH: path ? `${path}:${process.env.PATH}` : process.env.PATH,
        HOME: process.env.HOME,
        RUNNER_TEMP: runner,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_ACTION_PATH: ACTION,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'acme/app',
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({
      code, stdout, stderr, runner,
      outputs: parseOutputs(readFileSync(output, 'utf8')),
      summary: readFileSync(summary, 'utf8')
    }));
  });
}
