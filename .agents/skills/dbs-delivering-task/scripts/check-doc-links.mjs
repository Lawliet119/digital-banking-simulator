#!/usr/bin/env node
// Check relative links, heading anchors and embedded images in every tracked Markdown file.
// Usage (from the repo root): node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs
// Exits 1 when something is broken. No dependencies.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const files = execSync('git ls-files -co --exclude-standard "*.md"', { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.includes('node_modules/') && !f.includes('/templates/'));

const stripFences = (s) => s.replace(/```[\s\S]*?```/g, '');
const stripCode = (s) => stripFences(s).replace(/`[^`\n]*`/g, '');
const slug = (h) => h.trim().toLowerCase()
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '')
  .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

const anchors = new Map();
for (const f of files) {
  const p = resolve(root, f);
  if (!existsSync(p)) continue;
  const seen = new Map();
  const set = new Set();
  for (const m of stripFences(readFileSync(p, 'utf8')).matchAll(/^#{1,6}\s+(.*)$/gm)) {
    let s = slug(m[1]);
    const n = seen.get(s);
    seen.set(s, n === undefined ? 0 : n + 1);
    if (n !== undefined) s = `${s}-${n + 1}`;
    set.add(s.normalize('NFC'));
  }
  anchors.set(f, set);
}

let bad = 0;
for (const f of files) {
  const p = resolve(root, f);
  if (!existsSync(p)) continue;
  for (const m of stripCode(readFileSync(p, 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1];
    if (/^(https?:|mailto:)/.test(link)) continue;
    const [path, anchor] = link.split('#');
    const target = path ? resolve(dirname(p), decodeURI(path)) : p;
    if (path && !existsSync(target)) { console.log(`MISSING ${f}: ${link}`); bad++; continue; }
    const rel = relative(root, target).split('\\').join('/');
    if (anchor && anchors.has(rel) && !anchors.get(rel).has(decodeURIComponent(anchor).toLowerCase().normalize('NFC'))) {
      console.log(`ANCHOR  ${f}: ${link}`); bad++;
    }
  }
}
console.log(`${files.length} files checked, ${bad} broken link(s)`);
process.exit(bad ? 1 : 0);
