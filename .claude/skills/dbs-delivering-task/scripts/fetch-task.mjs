#!/usr/bin/env node
// Print one board task (and the status of its dependencies) from the team's Google Sheet,
// or list the tasks still To Do whose dependencies are Done, in board order.
// Usage: node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-79
//        node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs RSK-01     (RSK-1 works too)
//        node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs --next [Dev|Fraud|Ops] [count]
// Keys are <PREFIX>-<number>: DBS-n for the original board, RSK-nn for the fraud rule/AI tasks added
// with ADR-14. Needs Node >= 18 (global fetch). The sheet is readable by anyone with the link, so no
// login is needed.

const SHEET_ID = '18IHrZShDoZDc6bgnsi__ATyd99aeJxe4x4TWQ5WTz_w';
const TABS = [...Array.from({ length: 11 }, (_, w) => `Tuần ${w}`), 'Tài liệu đã chốt'];
const COLUMNS = ['Issue Key', 'Loại', 'Tóm tắt', 'Assignee (vai)', 'Ưu tiên', 'Status',
  'Phụ thuộc (phải xong trước)', 'Deliverable / Demo', 'Thực trạng', 'Expect', 'DoD (Definition of Done)'];

const KEY = /^[A-Z]+-\d+$/;
// Not inside a longer hyphenated name: "FRAUD-API-02" is a feature doc, not a board task.
const KEY_ANYWHERE = /(?<![A-Za-z0-9-])[A-Z]+-\d+(?![A-Za-z0-9-])/g;
/** `RSK-01` and `RSK-1` are the same task. */
const norm = (k) => k.toUpperCase().replace(/-0+(\d)/, '-$1');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadTab(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${tab}: HTTP ${res.status}`);
  return parseCsv(await res.text());
}

const key = (process.argv[2] || '').toUpperCase();
const nextMode = key === '--NEXT';
if (!nextMode && !KEY.test(key)) {
  console.error('Usage: node fetch-task.mjs <KEY>   (DBS-<n> or RSK-<n>)   |   node fetch-task.mjs --next [Dev|Fraud|Ops] [count]');
  process.exit(2);
}

// Every task on the board by normalised key; `name` keeps the key as written on the sheet.
const all = new Map();
for (const tab of TABS) {
  let rows;
  try { rows = await loadTab(tab); } catch (e) { console.error(`warn: ${e.message}`); continue; }
  for (const r of rows) {
    const name = (r[0] || '').trim();
    if (KEY.test(name)) all.set(norm(name), { name, tab, r });
  }
}
const depsOf = (r) => [...new Set((r[6] || '').match(KEY_ANYWHERE) || [])];

if (nextMode) {
  const roleArg = (process.argv[3] || 'Dev').toLowerCase();
  const want = roleArg === 'fraud' ? 'fraud' : roleArg === 'ops' ? 'ops' : 'dev';
  const count = Number(process.argv[4]) || 10;
  const roleOf = (label) => (/fraud/i.test(label) ? 'fraud' : /platform|ops/i.test(label) ? 'ops' : 'dev');
  const prio = { highest: -1, high: 0, medium: 1, low: 2 };
  const num = (s) => Number(String(s).replace(/\D/g, ''));
  const isDone = (k) => {
    const d = all.get(norm(k));
    return !d || d.tab === 'Tài liệu đã chốt' || /^done$/i.test((d.r[5] || '').trim());
  };
  const rows = [...all.values()]
    .filter(({ tab }) => /^Tuần \d+$/.test(tab))
    .filter(({ r }) => /^(to do|)$/i.test((r[5] || '').trim()))
    .filter(({ r }) => roleOf(r[3] || '') === want)
    .filter(({ r }) => depsOf(r).every(isDone))
    .sort((a, b) => num(a.tab) - num(b.tab)
      || (prio[(a.r[4] || '').trim().toLowerCase()] ?? 3) - (prio[(b.r[4] || '').trim().toLowerCase()] ?? 3)
      || (a.name.startsWith('DBS-') ? 0 : 1) - (b.name.startsWith('DBS-') ? 0 : 1)
      || num(a.name) - num(b.name));
  console.log(`# Backlog: ${rows.length} ${want} task(s) still To Do with dependencies Done, in board order\n`);
  for (const { name, tab, r } of rows.slice(0, count)) console.log(`- ${name} (${tab}, ${(r[4] || '?').trim()}) ${r[2]}`);
  console.log('\nDetails of one task: node fetch-task.mjs <KEY>');
  process.exit(0);
}

const hit = all.get(norm(key));
if (!hit) {
  console.error(`${key} not found on the board. Ask the human for the task description.`);
  process.exit(1);
}

const { name, tab, r } = hit;
console.log(`# ${name} (${tab})\n`);
if (tab === 'Tài liệu đã chốt') {
  console.log('This task was archived (already done or cancelled). Columns: key, old week, summary, assignee, result, where, old status.');
  console.log(r.map((v, i) => `- ${i}: ${v}`).join('\n'));
  process.exit(0);
}
COLUMNS.forEach((col, i) => console.log(`## ${col}\n${(r[i] || '').trim() || '—'}\n`));

const deps = depsOf(r);
if (deps.length) {
  console.log('## Trạng thái các task phụ thuộc');
  for (const d of deps) {
    const dep = all.get(norm(d));
    if (!dep) console.log(`- ${d}: KHÔNG TÌM THẤY trên board`);
    else if (dep.tab === 'Tài liệu đã chốt') console.log(`- ${d}: đã chốt/hủy (tab Tài liệu đã chốt)`);
    else console.log(`- ${d} (${dep.tab}): ${dep.r[5] || '?'} — ${dep.r[2]}`);
  }
}
