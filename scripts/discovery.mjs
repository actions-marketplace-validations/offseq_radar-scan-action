import { posix } from 'node:path';

const NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock',
  'Cargo.lock', 'go.mod', 'go.sum', 'composer.lock', 'Gemfile.lock', 'bom.json'
]);
const PATTERNS = [/^requirements.*\.txt$/, /\.cdx\.json$/, /\.spdx\.json$/];
const SKIP = /(^|\/)(node_modules|vendor|\.git)\//;
// Control characters in a path could inject workflow commands into the log.
export const isPrintable = path => !/[\0-\x1f\x7f]/.test(path);

export const MAX_FILES = 50;

export function isScannable(path) {
  const name = posix.basename(path);
  return NAMES.has(name) || PATTERNS.some(p => p.test(name));
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A trailing slash or a bare directory name excludes everything below it.
  return new RegExp(`^${re.replace(/\/$/, '')}(?:/.*)?$`);
}

export const matcher = globs => {
  const res = globs.map(g => globToRegExp(g.replace(/^\.\//, '')));
  return path => res.some(r => r.test(path));
};

// go.mod marks indirect dependencies, so it wins over go.sum in the same directory.
export function pickFiles(paths, { exclude = [] } = {}) {
  const excluded = matcher(exclude);
  const picked = paths.filter(p => isScannable(p) && isPrintable(p) && !SKIP.test(p) && !excluded(p));
  const goMods = new Set(picked.filter(p => posix.basename(p) === 'go.mod').map(p => posix.dirname(p)));
  return picked.filter(p => !(posix.basename(p) === 'go.sum' && goMods.has(posix.dirname(p)))).sort();
}
