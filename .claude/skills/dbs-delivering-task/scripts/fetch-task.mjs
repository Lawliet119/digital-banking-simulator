#!/usr/bin/env node
// Print one board task (and the status of its dependencies) from the team's Google Sheet,
// or list the tasks still To Do whose dependencies are Done, in board order.
// Usage: node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-79
//        node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs --next [Dev|Fraud|Ops] [count]
//        node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs CHORE-20261107-x   (off-board key: exit 0)
// Needs Node >= 18 (global fetch). The sheet is readable by anyone with the link, so no login is needed.
// Pure logic lives in board.mjs (tests: node --test .claude/skills/dbs-delivering-task/scripts/).
import {
  ARCHIVE_TAB, parseCsv, isArchiveTab, probeTabs, indexTasks, depState, blockedBy, topBlockers, roleOf, isToDo, classifyKey,
} from './board.mjs';

const SHEET_ID = '18IHrZShDoZDc6bgnsi__ATyd99aeJxe4x4TWQ5WTz_w';
const COLUMNS = ['Issue Key', 'Loại', 'Tóm tắt', 'Assignee (vai)', 'Ưu tiên', 'Status',
  'Phụ thuộc (phải xong trước)', 'Deliverable / Demo', 'Thực trạng', 'Expect', 'DoD (Definition of Done)'];
const STATE_LABEL = { unknown: 'KHÔNG TÌM THẤY trên board (tính là chưa Done)', cancelled: 'đã HỦY (tab Tài liệu đã chốt; tính là chưa Done)', open: 'chưa Done' };

async function loadText(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${tab}: HTTP ${res.status}`);
  return res.text();
}

const arg = process.argv[2] || '';
const kind = classifyKey(arg);
if (kind === 'invalid') {
  console.error('Usage: node fetch-task.mjs DBS-<n>   |   node fetch-task.mjs --next [Dev|Fraud|Ops] [count]');
  process.exit(2);
}
if (kind === 'off-board') {
  console.log(`${arg} không có trên board: đây là key ngoài board (task-kinds.md). Lấy mô tả và DoD từ người yêu cầu, ghi vào §1 của feature doc.`);
  process.exit(0);
}

const probe = await probeTabs(loadText);
if (probe.stop !== 'missing') console.error(`warn: dừng dò tab tuần ở ${probe.at} (${probe.stop === 'cap' ? 'đã tới giới hạn' : 'nội dung trùng tab trước'})`);
let archiveRows = [];
try {
  const rows = parseCsv(await loadText(ARCHIVE_TAB));
  if (isArchiveTab(rows)) archiveRows = rows;
  else console.error(`warn: tab "${ARCHIVE_TAB}" không tồn tại (gviz trả tab khác), bỏ qua`);
} catch (e) { console.error(`warn: ${e.message}`); }
const all = indexTasks(probe.weeks, archiveRows);

if (kind === 'next') {
  const roleArg = (process.argv[3] || 'Dev').toLowerCase();
  const want = roleArg === 'fraud' ? 'fraud' : roleArg === 'ops' ? 'ops' : 'dev';
  const count = Number(process.argv[4]) || 10;
  const prio = { highest: -1, high: 0, medium: 1, low: 2 };
  const num = (s) => Number(String(s).replace(/\D/g, ''));
  const rows = [...all.entries()]
    .filter(([, t]) => isToDo(t) && roleOf(t.r[3] || '') === want)
    .filter(([, t]) => blockedBy(t, all).length === 0)
    .sort(([ka, a], [kb, b]) => num(a.tab) - num(b.tab)
      || (prio[(a.r[4] || '').trim().toLowerCase()] ?? 3) - (prio[(b.r[4] || '').trim().toLowerCase()] ?? 3)
      || num(ka) - num(kb));
  console.log(`# Backlog: ${rows.length} ${want} task(s) still To Do with dependencies Done, in board order\n`);
  for (const [k, { tab, r }] of rows.slice(0, count)) console.log(`- ${k} (${tab}, ${(r[4] || '?').trim()}) ${r[2]}`);
  if (rows.length === 0) {
    console.log('Không có task nào sẵn sàng. Các task đang chặn nhiều task nhất:');
    for (const { key, count: n } of topBlockers(all, want).slice(0, count)) {
      const t = all.get(key);
      const where = t ? `${t.tab}, ${(t.archived ? t.r[4] : t.r[5]) || '?'}` : 'không có trên board';
      console.log(`- ${key} (${where}) chặn ${n} task`);
    }
  }
  console.log('\nDetails of one task: node fetch-task.mjs DBS-<n>');
  process.exit(0);
}

const key = arg.toUpperCase();
const hit = all.get(key);
if (!hit) {
  console.error(`${key} not found on the board. Ask the human for the task description.`);
  process.exit(1);
}

const { tab, r } = hit;
console.log(`# ${key} (${tab})\n`);
if (hit.archived) {
  console.log('This task was archived (already done or cancelled). Columns: key, old week, summary, assignee, result, where, old status.');
  console.log(r.map((v, i) => `- ${i}: ${v}`).join('\n'));
  process.exit(0);
}
COLUMNS.forEach((name, i) => console.log(`## ${name}\n${(r[i] || '').trim() || '—'}\n`));

const deps = [...new Set(((r[6] || '').match(/DBS-\d+/g) || []))];
if (deps.length) {
  console.log('## Trạng thái các task phụ thuộc');
  for (const d of deps) {
    const state = depState(d, all);
    const dep = all.get(d);
    if (state === 'unknown') console.log(`- ${d}: ${STATE_LABEL.unknown}`);
    else if (dep.archived) console.log(`- ${d}: ${state === 'done' ? 'Done (tab Tài liệu đã chốt)' : STATE_LABEL[state]}`);
    else console.log(`- ${d} (${dep.tab}): ${dep.r[5] || '?'} — ${dep.r[2]}`);
  }
}
