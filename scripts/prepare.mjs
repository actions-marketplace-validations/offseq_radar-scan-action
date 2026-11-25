import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_FILES, isPrintable, matcher, pickFiles } from './discovery.mjs';
import { readExclude } from './config.mjs';

export const escapeCommand = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

export function readAt(root, ref, path) {
  if (!git(root, ['ls-tree', '-z', ref, '--', path])) return null;
  return git(root, ['cat-file', 'blob', `${ref}:${path}`]);
}

const listTracked = root => git(root, ['ls-files', '-z']).split('\0').filter(Boolean);

// A symlink, or a path through one, could send any readable file, such as .git/config with the checkout token.
const isPlainFile = (root, rel) => {
  const abs = join(root, rel);
  try { return lstatSync(abs).isFile() && realpathSync(abs) === abs; } catch { return false; }
};

export function selectFiles({ root, cwd, explicit, exclude }) {
  const plain = p => isPlainFile(root, p);
  if (!explicit.length) return pickFiles(listTracked(root), { exclude }).filter(plain);
  cwd = realpathSync(cwd);
  let tracked;
  const out = new Set();
  for (const entry of explicit) {
    const rel = relative(root, resolve(cwd, entry)).split(sep).join('/');
    if (/[*?]/.test(entry)) {
      tracked ??= listTracked(root);
      const hits = tracked.filter(matcher([rel])).filter(p => isPrintable(p) && plain(p));
      if (!hits.length) throw new Error(`No tracked file matches ${entry}`);
      hits.forEach(h => out.add(h));
      continue;
    }
    if (!existsSync(resolve(cwd, entry))) throw new Error(`File not found: ${entry}`);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`${entry} is outside the repository`);
    if (!plain(rel)) throw new Error(`${entry} is not a regular file (symlinks are not followed)`);
    out.add(rel);
  }
  return [...out].sort();
}

export function classify(head, base) {
  if (base === null) return { isNew: true };
  return base === head ? { unchanged: true } : { base: { content: base } };
}

const MODE = f => (f.isNew ? 'new' : f.unchanged ? 'unchanged' : f.base ? 'changed' : 'full');

export function prepare({ cwd, file, files, config, baseSha }) {
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  if (isAbsolute(config) || config.split('/').includes('..')) throw new Error('config must be a path inside the repository');
  const configText = baseSha ? readAt(root, baseSha, config) : existsSync(resolve(root, config)) ? readFileSync(resolve(root, config), 'utf8') : null;
  const explicit = [file, ...files.split('\n')].map(s => s.trim()).filter(Boolean);
  const selected = selectFiles({ root, cwd, explicit, exclude: readExclude(configText) });
  if (selected.length > MAX_FILES) throw new Error(`${selected.length} files to scan, more than ${MAX_FILES}. Narrow the files input or add paths.exclude to ${config}.`);
  const body = {
    files: selected.map(filename => {
      const content = readFileSync(resolve(root, filename), 'utf8');
      return { content, filename, ...(baseSha ? classify(content, readAt(root, baseSha, filename)) : {}) };
    }),
    ...(configText != null ? { config: configText } : {})
  };
  return { body, files: body.files.map(f => ({ filename: f.filename, mode: MODE(f) })) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { RADAR_FILE = '', RADAR_FILES = '', RADAR_CONFIG = '.github/radar.yml', RADAR_BASE_SHA = '' } = process.env;
    const { body, files } = prepare({ cwd: process.cwd(), file: RADAR_FILE, files: RADAR_FILES, config: RADAR_CONFIG, baseSha: RADAR_BASE_SHA });
    writeFileSync(process.argv[2], JSON.stringify(body));
    writeFileSync(process.argv[3], JSON.stringify({ files }));
  } catch (err) {
    console.log(`::error::${escapeCommand(err.stderr?.toString().trim() || err.message)}`);
    process.exit(1);
  }
}
