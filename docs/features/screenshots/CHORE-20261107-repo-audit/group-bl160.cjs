// Usage: node group-bl160.cjs merged.json  — groups merged PRs for BL-160 by the shared money-path list.
const prs = require(require('path').resolve(process.argv[2]));
const money = /^backend\/src\/(modules\/(ledger|accounts|audit|outbox|identity)\/|database\/migrations\/|database\/transaction\.|common\/(money|auth|events)\/|config\/limits\.config\.ts$)/;
const docsOnly = (files) => files.every((f) => /\.md$/.test(f) || f.startsWith('.claude/'));
const groups = { money: [], other: [], docs: [] };
for (const p of prs.sort((a, b) => a.number - b.number)) {
  const files = p.files.map((f) => f.path);
  const g = files.some((f) => money.test(f)) ? 'money' : docsOnly(files) ? 'docs' : 'other';
  groups[g].push('#' + p.number + (files.length === 0 ? '(0 file)' : ''));
}
for (const [g, l] of Object.entries(groups)) console.log(g, l.length, l.join(' '));
