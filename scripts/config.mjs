const unquote = s => {
  const v = s.trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  return /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v;
};
const stripComment = s => s.replace(/\s+#.*$/, '').trimEnd();
const strings = list => (Array.isArray(list) && list.every(x => typeof x === 'string') ? list : []);

// The server parses the whole config; discovery only needs paths.exclude. Anything this
// subset cannot read excludes nothing, so a misread config scans more, never less.
export function readExclude(text) {
  if (!text || !text.trim()) return [];
  try { return strings(JSON.parse(text)?.paths?.exclude); } catch {}
  const lines = text.split(/\r?\n/);
  const paths = lines.findIndex(l => /^paths:\s*(#.*)?$/.test(l));
  if (paths === -1) return [];
  for (let i = paths + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const m = /^(\s+)exclude:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = stripComment(m[2]).trim();
    if (inline.startsWith('[')) {
      if (!inline.endsWith(']')) return [];
      return inline.slice(1, -1).split(',').map(unquote).filter(Boolean);
    }
    if (inline) return [];
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
      const item = /^(\s*)-\s+(.*)$/.exec(lines[j]);
      if (!item || item[1].length < m[1].length) break;
      out.push(unquote(stripComment(item[2])));
    }
    return out;
  }
  return [];
}
