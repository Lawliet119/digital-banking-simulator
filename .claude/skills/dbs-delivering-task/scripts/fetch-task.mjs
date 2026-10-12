#!/usr/bin/env node
// Print one board task (and the status of its dependencies) from the team's Google Sheet.
// Usage: node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-79
// Needs Node >= 18 (global fetch). The sheet is readable by anyone with the link, so no login is needed.

const SHEET_ID = '18IHrZShDoZDc6bgnsi__ATyd99aeJxe4x4TWQ5WTz_w';
const TABS = [...Array.from({ length: 11 }, (_, w) => `Tuần ${w}`), 'Tài liệu đã chốt'];
const COLUMNS = ['Issue Key', 'Loại', 'Tóm tắt', 'Assignee (vai)', 'Reviewer', 'Ưu tiên', 'Status',
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
if (!/^DBS-\d+$/.test(key)) {
  console.error('Usage: node fetch-task.mjs DBS-<n>');
  process.exit(2);
}

const all = new Map();
for (const tab of TABS) {
  let rows;
  try { rows = await loadTab(tab); } catch (e) { console.error(`warn: ${e.message}`); continue; }
  for (const r of rows) if (/^DBS-\d+$/.test((r[0] || '').trim())) all.set(r[0].trim(), { tab, r });
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

const deps = [...new Set(((r[7] || '').match(/DBS-\d+/g) || []))];
if (deps.length) {
  console.log('## Trạng thái các task phụ thuộc');
  for (const d of deps) {
    const dep = all.get(d);
    if (!dep) console.log(`- ${d}: KHÔNG TÌM THẤY trên board`);
    else if (dep.tab === 'Tài liệu đã chốt') console.log(`- ${d}: đã chốt/hủy (tab Tài liệu đã chốt)`);
    else console.log(`- ${d} (${dep.tab}): ${dep.r[6] || '?'} — ${dep.r[2]}`);
  }
}
