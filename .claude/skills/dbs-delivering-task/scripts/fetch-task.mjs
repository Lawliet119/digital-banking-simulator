#!/usr/bin/env node
// Print one board task (and the status of its dependencies) from the team's Google Sheet,
// or list the tasks still To Do whose dependencies are Done, in board order.
// Usage: node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-79
//        node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs --next [Dev|Fraud|Ops] [count]
// Needs Node >= 18 (global fetch). The sheet is readable by anyone with the link, so no login is needed.

const SHEET_ID = '18IHrZShDoZDc6bgnsi__ATyd99aeJxe4x4TWQ5WTz_w';
const TABS = [...Array.from({ length: 11 }, (_, w) => `Tuần ${w}`), 'Tài liệu đã chốt'];
const COLUMNS = ['Issue Key', 'Loại', 'Tóm tắt', 'Assignee (vai)', 'Ưu tiên', 'Status',
  'Phụ thuộc (phải xong trước)', 'Deliverable / Demo', 'Thực trạng', 'Expect', 'DoD (Definition of Done)'];

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
if (!nextMode && !/^DBS-\d+$/.test(key)) {
  console.error('Usage: node fetch-task.mjs DBS-<n>   |   node fetch-task.mjs --next [Dev|Fraud|Ops] [count]');
  process.exit(2);
}

const all = new Map();
for (const tab of TABS) {
  let rows;
  try { rows = await loadTab(tab); } catch (e) { console.error(`warn: ${e.message}`); continue; }
  for (const r of rows) if (/^DBS-\d+$/.test((r[0] || '').trim())) all.set(r[0].trim(), { tab, r });
}

if (nextMode) {
  const roleArg = (process.argv[3] || 'Dev').toLowerCase();
  const want = roleArg === 'fraud' ? 'fraud' : roleArg === 'ops' ? 'ops' : 'dev';
  const count = Number(process.argv[4]) || 10;
  const roleOf = (label) => (/fraud/i.test(label) ? 'fraud' : /platform|ops/i.test(label) ? 'ops' : 'dev');
  const prio = { highest: -1, high: 0, medium: 1, low: 2 };
  const num = (s) => Number(String(s).replace(/\D/g, ''));
  const isDone = (k) => {
    const d = all.get(k);
    return !d || d.tab === 'Tài liệu đã chốt' || /^done$/i.test((d.r[5] || '').trim());
  };
  const rows = [...all.entries()]
    .filter(([, { tab }]) => /^Tuần \d+$/.test(tab))
    .filter(([, { r }]) => /^(to do|)$/i.test((r[5] || '').trim()))
    .filter(([, { r }]) => roleOf(r[3] || '') === want)
    .filter(([, { r }]) => [...new Set((r[6] || '').match(/DBS-\d+/g) || [])].every(isDone))
    .sort(([ka, a], [kb, b]) => num(a.tab) - num(b.tab)
      || (prio[(a.r[4] || '').trim().toLowerCase()] ?? 3) - (prio[(b.r[4] || '').trim().toLowerCase()] ?? 3)
      || num(ka) - num(kb));
  console.log(`# Backlog: ${rows.length} ${want} task(s) still To Do with dependencies Done, in board order\n`);
  for (const [k, { tab, r }] of rows.slice(0, count)) console.log(`- ${k} (${tab}, ${(r[4] || '?').trim()}) ${r[2]}`);
  console.log('\nDetails of one task: node fetch-task.mjs DBS-<n>');
  process.exit(0);
}

const hit = all.get(key);
if (!hit) {
  console.error(`${key} not found on the board. Ask the human for the task description.`);
  process.exit(1);
}

const { tab, r } = hit;
console.log(`# ${key} (${tab})\n`);
if (tab === 'Tài liệu đã chốt') {
  console.log('This task was archived (already done or cancelled). Columns: key, old week, summary, assignee, result, where, old status.');
  console.log(r.map((v, i) => `- ${i}: ${v}`).join('\n'));
  process.exit(0);
}
COLUMNS.forEach((name, i) => console.log(`## ${name}\n${(r[i] || '').trim() || '—'}\n`));

const deps = [...new Set(((r[6] || '').match(/DBS-\d+/g) || []))];
if (deps.length) {
  console.log('## Trạng thái các task phụ thuộc');
  for (const d of deps) {
    const dep = all.get(d);
    if (!dep) console.log(`- ${d}: KHÔNG TÌM THẤY trên board`);
    else if (dep.tab === 'Tài liệu đã chốt') console.log(`- ${d}: đã chốt/hủy (tab Tài liệu đã chốt)`);
    else console.log(`- ${d} (${dep.tab}): ${dep.r[5] || '?'} — ${dep.r[2]}`);
  }
}
