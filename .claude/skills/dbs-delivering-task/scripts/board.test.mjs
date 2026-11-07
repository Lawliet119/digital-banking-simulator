// Tests for board.mjs. Run: node --test .claude/skills/dbs-delivering-task/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, isBoardTab, isArchiveTab, probeTabs, indexTasks, depState, blockedBy, topBlockers, classifyKey,
} from './board.mjs';

const HEADER = 'Issue Key,Loại,Tóm tắt,Assignee (vai),Ưu tiên,Status,Phụ thuộc (phải xong trước),Deliverable / Demo,Thực trạng,Expect,DoD';
const ARCHIVE_HEADER = 'Issue Key,Tuần cũ,Tóm tắt,Assignee (vai),Kết quả,Kết quả nằm ở,Status trước khi chuyển';
const OVERVIEW = '"Digital Banking Simulator — Tổng quan tiến độ"\n"Tuần 0","01–04/10","Chuẩn bị","7"';
const week = (...lines) => ['"Tuần N — tiêu đề"', HEADER, ...lines].join('\n');
const row = (key, status, deps = '', role = 'Dev') => `${key},Task,Tóm tắt ${key},${role},High,${status},"${deps}",,,,`;

test('TC-SKILL-01 isBoardTab: false for the overview tab gviz returns for an unknown tab name', () => {
  assert.equal(isBoardTab(parseCsv(OVERVIEW)), false);
  assert.equal(isBoardTab(parseCsv(week(row('DBS-1', 'Done')))), true);
  assert.equal(isBoardTab(parseCsv(ARCHIVE_HEADER)), false, 'archive tab has other columns');
  assert.equal(isArchiveTab(parseCsv(ARCHIVE_HEADER)), true);
});

test('TC-SKILL-02 probeTabs stops at the first missing tab, at a duplicate payload, or at the cap', async () => {
  const tabs = { 'Tuần 0': week(row('DBS-1', 'Done')), 'Tuần 1': week(row('DBS-2', 'To Do')) };
  const missing = await probeTabs(async (t) => tabs[t] ?? OVERVIEW);
  assert.deepEqual(missing.weeks.map((w) => w.tab), ['Tuần 0', 'Tuần 1']);
  assert.equal(missing.stop, 'missing');

  // A payload equal to ANY earlier one (not only the previous) stops the probe.
  const dup = await probeTabs(async (t) => ({ 'Tuần 0': tabs['Tuần 0'], 'Tuần 1': tabs['Tuần 1'], 'Tuần 2': tabs['Tuần 0'] }[t] ?? OVERVIEW));
  assert.deepEqual(dup.weeks.map((w) => w.tab), ['Tuần 0', 'Tuần 1']);
  assert.equal(dup.stop, 'duplicate');

  let calls = 0;
  const capped = await probeTabs(async (t) => { calls++; return week(row(`DBS-${100 + calls}`, 'Done')); }, 30);
  assert.equal(capped.weeks.length, 30);
  assert.equal(capped.stop, 'cap');
  assert.equal(calls, 30);
});

test('TC-SKILL-02 depState and blockedBy: unknown and cancelled dependencies are not Done', () => {
  const weeks = [{ tab: 'Tuần 1', rows: parseCsv(week(
    row('DBS-10', 'To Do', 'DBS-999, DBS-5, DBS-6, DBS-7'),
    row('DBS-7', 'Done'),
  )) }];
  const archive = parseCsv([ARCHIVE_HEADER, 'DBS-5,Tuần 0,Viết ADR,Dev,Done,docs/adr,To Do', 'DBS-6,Tuần 0,Bỏ,Dev,Hủy,—,To Do'].join('\n'));
  const all = indexTasks(weeks, archive);
  assert.equal(depState('DBS-999', all), 'unknown');
  assert.equal(depState('DBS-5', all), 'done');
  assert.equal(depState('DBS-6', all), 'cancelled');
  assert.equal(depState('DBS-7', all), 'done');
  const b = blockedBy(all.get('DBS-10'), all);
  assert.deepEqual(b.map((d) => `${d.key}:${d.state}`), ['DBS-999:unknown', 'DBS-6:cancelled']);
});

test('TC-SKILL-03 topBlockers ranks the task that blocks the most To Do tasks first', () => {
  const lines = [row('DBS-61', 'In Progress'), row('DBS-53', 'In Review'), row('DBS-20', 'Done')];
  for (let i = 0; i < 9; i++) lines.push(row(`DBS-${80 + i}`, 'To Do', 'DBS-61, DBS-20'));
  lines.push(row('DBS-90', 'To Do', 'DBS-53'));
  const all = indexTasks([{ tab: 'Tuần 3', rows: parseCsv(week(...lines)) }], []);
  const top = topBlockers(all, 'dev');
  assert.deepEqual(top[0], { key: 'DBS-61', count: 9 });
  assert.deepEqual(top[1], { key: 'DBS-53', count: 1 });
  assert.equal(top.some((t) => t.key === 'DBS-20'), false, 'a Done task blocks nothing');
});

test('TC-SKILL-04 classifyKey', () => {
  assert.equal(classifyKey('DBS-61'), 'board');
  assert.equal(classifyKey('dbs-61'), 'board');
  assert.equal(classifyKey('CHORE-20261107-repo-audit'), 'off-board');
  assert.equal(classifyKey('BUG-20261107-x'), 'off-board');
  assert.equal(classifyKey('FRAUD-API-01'), 'off-board');
  assert.equal(classifyKey('--next'), 'next');
  assert.equal(classifyKey('xyz'), 'invalid');
  assert.equal(classifyKey('CHORE-2026-x'), 'invalid');
  assert.equal(classifyKey(''), 'invalid');
});
