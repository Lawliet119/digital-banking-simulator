// Chạy: node --test .claude/skills/dbs-delivering-task/scripts/check-backlog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBacklog, checkRulesDefined, RULES } from './check-backlog.mjs';

const HEAD =
  '| ID | Việc còn thiếu | Nguồn | Vai đề xuất | Đóng khi | Ưu tiên | Xử lý | Hạn |\n|---|---|---|---|---|---|---|---|';
const row = (id, over = {}) => {
  const c = {
    work: 'việc',
    src: '[DBS-1](features/DBS-1.md)',
    role: 'Dev',
    done: 'xong',
    pri: 'Trung bình',
    fix: 'Trước tải · T2',
    due: 'Trước DBS-166 (tuần 7, đã trễ)',
    ...over,
  };
  return `| ${id} | ${c.work} | ${c.src} | ${c.role} | ${c.done} | ${c.pri} | ${c.fix} | ${c.due} |`;
};
const doc = (...rows) => `# Backlog\n\n## Dev\n\n${HEAD}\n${rows.join('\n')}\n`;
const errs = text => checkBacklog(text).errors.join('\n');

test('TC-141-01 một bảng đúng định dạng không có lỗi', () => {
  const r = checkBacklog(doc(row('BL-001'), row('BL-002', { pri: 'Thấp', fix: 'Hoãn · H2', due: 'Không có' })));
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
});

test('TC-141-02 dòng thiếu cột bị từ chối', () => {
  assert.match(errs(doc('| BL-001 | việc | nguồn | Dev | xong |')), /BL-001.*8 cột/);
});

test('TC-141-03 ưu tiên lạ, hoặc ngoài tập cho phép của mã, bị từ chối', () => {
  assert.match(errs(doc(row('BL-001', { pri: 'Gấp' }))), /BL-001.*Ưu tiên/);
  assert.match(errs(doc(row('BL-001', { pri: 'Thấp' }))), /BL-001.*T2.*Cao, Trung bình/);
  // T1 và T3 luôn Cao; H1 có thể nâng lên Trung bình nhưng không lên Cao.
  assert.match(errs(doc(row('BL-001', { fix: 'Trước tải · T1', pri: 'Trung bình' }))), /BL-001.*T1/);
  assert.deepEqual(checkBacklog(doc(row('BL-001', { fix: 'Hoãn · H5', pri: 'Trung bình', due: '2026-11-26' }))).errors, []);
  assert.match(errs(doc(row('BL-001', { fix: 'Hoãn · H5', pri: 'Cao', due: 'Không có' }))), /BL-001.*H5/);
});

test('TC-141-04 cột Xử lý: sai định dạng, mã lạ, nhóm không khớp mã, bị từ chối', () => {
  for (const fix of ['Trước tải', 'Trước tải - T2', 'Trước tải · T9', 'Hoãn · T2', 'Sau tải · H1', 'Trước tải · T2 (DBS-166)']) {
    assert.match(errs(doc(row('BL-001', { fix }))), /BL-001.*Xử lý/, fix);
  }
});

test('TC-141-05 ID trùng, ID sai dạng, thứ tự ID không tăng trong một mục: bị từ chối', () => {
  assert.match(errs(doc(row('BL-001'), row('BL-001'))), /BL-001.*trùng/);
  assert.match(errs(doc(row('BL-1'))), /BL-1.*ID/);
  assert.match(errs(doc(row('BL-005'), row('BL-003'))), /BL-003.*tăng dần/);
});

test('TC-141-06 ô Việc, Nguồn, Vai, Đóng khi, Hạn để trống bị từ chối (mọi việc có người nhận và hạn)', () => {
  for (const key of ['work', 'src', 'role', 'done', 'due']) {
    assert.match(errs(doc(row('BL-001', { [key]: ' ' }))), /BL-001.*trống/, key);
  }
});

test('TC-141-07 dấu gạch đứng đã thoát trong ô không tách cột', () => {
  assert.deepEqual(checkBacklog(doc(row('BL-001', { work: 'a \\| b' }))).errors, []);
});

test('TC-141-08 tiêu đề bảng sai cột bị từ chối', () => {
  const bad = doc(row('BL-001')).replace('| Ưu tiên | Xử lý | Hạn |', '| Xử lý | Ưu tiên | Hạn |');
  assert.match(errs(bad), /tiêu đề/);
});

test('TC-141-09 tóm tắt đếm đúng theo mục, nhóm xử lý và ưu tiên', () => {
  const text = `${doc(row('BL-001'), row('BL-002', { pri: 'Cao', fix: 'Trước tải · T1' }))}\n## Fraud\n\n${HEAD}\n${row('BL-003', { pri: 'Thấp', fix: 'Hoãn · H5', due: 'Không có' })}\n${row('BL-004', { fix: 'Trong tải · L (DBS-166)', due: 'DBS-166 (tuần 7)' })}\n`;
  const r = checkBacklog(text);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.summary.bySection, { Dev: 2, Fraud: 2 });
  assert.deepEqual(r.summary.byClass, { 'Trước tải': 2, Hoãn: 1, 'Trong tải': 1 });
  assert.deepEqual(r.summary.byPriority, { Cao: 1, 'Trung bình': 2, Thấp: 1 });
  assert.equal(r.summary.total, 4);
});

test('TC-141-10 dòng BL nằm ngoài mọi bảng có tiêu đề bị từ chối', () => {
  assert.match(errs(`# x\n\n${row('BL-001')}\n`), /BL-001.*ngoài bảng/);
});

test('TC-141-14 đầu BACKLOG phải định nghĩa đủ các mã, đúng nhóm và ưu tiên mặc định', () => {
  const line = c => `| ${c} | ${RULES[c].cls} | ${RULES[c].defaultPri} | áp khi |`;
  const full = Object.keys(RULES).map(line).join('\n');
  assert.deepEqual(checkRulesDefined(full), []);
  const missing = Object.keys(RULES).filter(c => c !== 'T3').map(line).join('\n');
  assert.match(checkRulesDefined(missing).join('\n'), /T3/);
  const wrong = full.replace('| T1 | Trước tải | Cao |', '| T1 | Trước tải | Thấp |');
  assert.match(checkRulesDefined(wrong).join('\n'), /T1.*Cao/);
});

test('TC-141-18 mã L và H6 bắt buộc nêu task đảm nhận; mã khác không được nêu', () => {
  assert.match(errs(doc(row('BL-001', { fix: 'Trong tải · L' }))), /BL-001.*task/);
  assert.match(errs(doc(row('BL-001', { fix: 'Hoãn · H6', pri: 'Thấp', due: 'Không có' }))), /BL-001.*task/);
  assert.deepEqual(
    checkBacklog(doc(row('BL-001', { fix: 'Hoãn · H6 (DBS-187, RSK-04)', pri: 'Thấp', due: 'DBS-188 (tuần 8)' }))).errors,
    [],
  );
  assert.match(errs(doc(row('BL-001', { fix: 'Hoãn · H2 (DBS-1)', pri: 'Thấp', due: 'Không có' }))), /BL-001.*Xử lý/);
});

test('TC-141-19 cột Hạn: chấp nhận các dạng đã định nghĩa, từ chối dạng khác', () => {
  for (const due of ['Không có', 'Ngay', '2026-11-26', 'Trước DBS-166 (tuần 7, đã trễ)', 'DBS-188 (tuần 8)', 'Sau BL-390', 'Tuần 5 (đã trễ)', 'Tuần 9']) {
    assert.deepEqual(checkBacklog(doc(row('BL-001', { due }))).errors, [], due);
  }
  for (const due of ['sớm', '26/11', 'Trước DBS-166 tuần 7', '2026-13-45x']) {
    assert.match(errs(doc(row('BL-001', { due }))), /BL-001.*Hạn/, due);
  }
});

test('TC-141-20 dòng viết lệch (không khoảng trắng, hai khoảng trắng, thụt đầu dòng) vẫn bị bắt; CRLF không làm hỏng', () => {
  assert.match(errs(doc('|BL-001| việc | nguồn | Dev | xong |')), /BL-001.*8 cột/);
  assert.match(errs(doc('| BL-001  | việc | nguồn | Dev | xong |')), /BL-001.*8 cột/);
  assert.match(errs(doc('  | BL-001 | việc |')), /BL-001/);
  const crlf = doc(row('BL-001'), row('BL-002')).replace(/\n/g, '\r\n');
  assert.deepEqual(checkBacklog(crlf).errors, []);
});

test('TC-141-21 dòng ngoài bảng có chữ BL- không phải ID không bị tính; văn xuôi không bị bắt', () => {
  const text = `${doc(row('BL-001'))}\nGhi chú: xem BL-001 và | không phải dòng bảng\n`;
  assert.deepEqual(checkBacklog(text).errors, []);
});
