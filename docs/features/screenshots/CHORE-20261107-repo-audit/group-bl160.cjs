// Usage: node group-bl160.cjs merged.json  — groups merged PRs for BL-160 by the shared money-path list.
// merged.json: [{ number, files: [{ path }] }], e.g. from `gh pr view <n> --json number,files` for each merged PR.
const money = /^backend\/src\/(modules\/(ledger|accounts|audit|outbox|identity)\/|database\/migrations\/|database\/transaction\.|common\/(money|auth|events)\/|config\/limits\.config\.ts$)/;
const docsOnly = (files) => files.every((f) => /\.md$/.test(f) || f.startsWith('.claude/'));

function group(prs) {
  const groups = { money: [], other: [], docs: [] };
  for (const p of [...prs].sort((a, b) => a.number - b.number)) {
    const files = p.files.map((f) => f.path);
    const g = files.some((f) => money.test(f)) ? 'money' : docsOnly(files) ? 'docs' : 'other';
    groups[g].push(p.number);
  }
  return groups;
}

module.exports = { group };

if (require.main === module) {
  const prs = require(require('path').resolve(process.argv[2]));
  const zero = new Set(prs.filter((p) => p.files.length === 0).map((p) => p.number));
  for (const [g, l] of Object.entries(group(prs)))
    console.log(g, l.length, l.map((n) => '#' + n + (zero.has(n) ? '(0 file)' : '')).join(' '));
}
