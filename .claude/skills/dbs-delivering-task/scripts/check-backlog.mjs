#!/usr/bin/env node
// Kiểm bảng docs/BACKLOG.md (DBS-141): mỗi dòng BL-NNN có đủ 8 cột, người nhận, hạn, mức ưu tiên và nhóm xử lý khớp mã quy tắc.
//   node .claude/skills/dbs-delivering-task/scripts/check-backlog.mjs [đường dẫn] [--summary]
// Mã thoát: 0 sạch, 1 có lỗi. `--summary` in số dòng theo mục, nhóm xử lý và mức ưu tiên (để gửi cả nhóm).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIORITIES = ['Cao', 'Trung bình', 'Thấp'];
/**
 * Mã quy tắc (định nghĩa ở đầu docs/BACKLOG.md). `defaultPri` là mức mặc định ghi ở bảng mã; `allowed` là các mức
 * dòng được ghi (nâng hoặc hạ có lý do, ví dụ cổng đã trễ, hạn cứng). `needsTask`: mã phải nêu task board đảm nhận.
 */
export const RULES = {
  T1: { cls: 'Trước tải', defaultPri: 'Cao', allowed: ['Cao'] },
  T2: { cls: 'Trước tải', defaultPri: 'Trung bình', allowed: ['Cao', 'Trung bình'] },
  T3: { cls: 'Trước tải', defaultPri: 'Cao', allowed: ['Cao'] },
  T4: { cls: 'Trước tải', defaultPri: 'Trung bình', allowed: ['Cao', 'Trung bình'] },
  L: { cls: 'Trong tải', defaultPri: 'Trung bình', allowed: ['Cao', 'Trung bình'], needsTask: true },
  H1: { cls: 'Hoãn', defaultPri: 'Thấp', allowed: ['Thấp', 'Trung bình'] },
  H2: { cls: 'Hoãn', defaultPri: 'Thấp', allowed: ['Thấp', 'Trung bình'] },
  H3: { cls: 'Hoãn', defaultPri: 'Trung bình', allowed: PRIORITIES },
  H4: { cls: 'Hoãn', defaultPri: 'Trung bình', allowed: PRIORITIES },
  H5: { cls: 'Hoãn', defaultPri: 'Thấp', allowed: ['Thấp', 'Trung bình'] },
  H6: { cls: 'Hoãn', defaultPri: 'Thấp', allowed: ['Thấp', 'Trung bình'], needsTask: true },
};
const COLUMNS = ['ID', 'Việc còn thiếu', 'Nguồn', 'Vai đề xuất', 'Đóng khi', 'Ưu tiên', 'Xử lý', 'Hạn'];
const FIX = /^(Trước tải|Trong tải|Hoãn) · ([TLH]\d?)(?: \(((?:DBS|RSK)-\d+(?:, (?:DBS|RSK)-\d+)*)\))?$/;
const DUE = [
  /^Không có$/,
  /^Ngay$/,
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  /^(Trước |Sau )?(DBS|RSK|BL)-\d+( \(tuần \d+(, đã trễ)?\))?$/,
  /^Tuần \d+( \(đã trễ\))?$/,
];

/** Tách một dòng bảng Markdown theo `|` chưa thoát; `\|` là một ký tự trong ô. */
function cells(line) {
  const out = [];
  let cur = '';
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (s[i] === '|') {
      out.push(cur);
      cur = '';
    } else cur += s[i];
  }
  out.push(cur);
  // Dòng bắt đầu và kết thúc bằng `|`: bỏ hai phần rỗng ở hai đầu.
  return out.slice(1, -1).map(c => c.trim());
}

/** Đầu BACKLOG phải có bảng mã: mỗi dòng `| <mã> | <nhóm> | <ưu tiên mặc định> | …` khớp `RULES`. */
export function checkRulesDefined(text) {
  const errors = [];
  const defined = new Map();
  for (const line of text.replace(/\r/g, '').split('\n'))
    if (/^\s*\| ([TLH]\d?) \|/.test(line)) {
      const c = cells(line);
      defined.set(c[0], c);
    }
  for (const [code, rule] of Object.entries(RULES)) {
    const c = defined.get(code);
    if (!c) errors.push(`Đầu BACKLOG chưa định nghĩa mã ${code}`);
    else if (c[1] !== rule.cls || c[2] !== rule.defaultPri)
      errors.push(`Đầu BACKLOG: mã ${code} phải là «${rule.cls}» và ưu tiên mặc định «${rule.defaultPri}», đang ghi «${c[1]}» «${c[2]}»`);
  }
  return errors;
}

export function checkBacklog(rawText) {
  const text = rawText.replace(/\r/g, '');
  const errors = [];
  const rows = [];
  const seen = new Set();
  let section = null;
  let headerOk = false;
  let lastId = '';
  for (const line of text.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      headerOk = false;
      lastId = '';
      continue;
    }
    if (!/^\s*\|/.test(line)) continue;
    const c = cells(line);
    if (c[0] === 'ID') {
      headerOk = COLUMNS.length === c.length && COLUMNS.every((name, i) => c[i] === name);
      if (!headerOk) errors.push(`Mục «${section}»: tiêu đề bảng phải là ${COLUMNS.join(' | ')}`);
      continue;
    }
    // Chỉ các dòng có ô đầu bắt đầu bằng BL- là dòng dữ liệu; dòng phân cách `|---|` và bảng khác bị bỏ qua.
    if (!/^BL-/.test(c[0] ?? '')) continue;
    const label = c[0];
    if (section === null || !headerOk) {
      errors.push(`${label}: dòng nằm ngoài bảng có tiêu đề hợp lệ`);
      continue;
    }
    if (c.length !== COLUMNS.length) {
      errors.push(`${label}: cần ${COLUMNS.length} cột, có ${c.length}`);
      continue;
    }
    const [id, work, src, role, done, pri, fix, due] = c;
    if (!/^BL-\d{3}$/.test(id)) errors.push(`${label}: ID phải dạng BL-NNN`);
    else {
      if (seen.has(id)) errors.push(`${id}: ID trùng`);
      if (lastId !== '' && id <= lastId && !seen.has(id)) errors.push(`${id}: trong một mục, ID phải tăng dần (sau ${lastId})`);
      seen.add(id);
      lastId = id;
    }
    for (const [name, value] of [
      ['Việc còn thiếu', work],
      ['Nguồn', src],
      ['Vai đề xuất', role],
      ['Đóng khi', done],
      ['Hạn', due],
    ])
      if (value === '') errors.push(`${id}: ô «${name}» trống (mọi việc phải có người nhận, điều kiện đóng và hạn)`);
    if (due !== '' && !DUE.some(re => re.test(due))) errors.push(`${id}: Hạn «${due}» không đúng dạng định nghĩa ở đầu BACKLOG`);
    if (!PRIORITIES.includes(pri)) errors.push(`${id}: Ưu tiên «${pri}» phải là ${PRIORITIES.join(', ')}`);
    const m = FIX.exec(fix);
    const rule = m ? RULES[m[2]] : undefined;
    if (!m || !rule) errors.push(`${id}: Xử lý «${fix}» không đúng dạng «Trước tải · T1..T4», «Trong tải · L (DBS-n)» hoặc «Hoãn · H1..H6»`);
    else if (rule.cls !== m[1]) errors.push(`${id}: Xử lý «${fix}»: mã ${m[2]} thuộc nhóm ${rule.cls}`);
    else if (Boolean(rule.needsTask) !== Boolean(m[3]))
      errors.push(`${id}: Xử lý «${fix}»: mã ${m[2]} ${rule.needsTask ? 'phải nêu task board đảm nhận, ví dụ (DBS-166)' : 'không nêu task'}`);
    else if (PRIORITIES.includes(pri) && !rule.allowed.includes(pri))
      errors.push(`${id}: mã ${m[2]} chỉ cho Ưu tiên ${rule.allowed.join(', ')}, dòng ghi ${pri}`);
    rows.push({ id, section, role, pri, fix, due, cls: m?.[1], code: m?.[2] });
  }
  const tally = key => rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc), {});
  return {
    errors,
    rows,
    summary: { total: rows.length, bySection: tally('section'), byClass: tally('cls'), byPriority: tally('pri') },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const path = args[0] ?? resolve(root, 'docs/BACKLOG.md');
  const text = readFileSync(path, 'utf8');
  const result = checkBacklog(text);
  result.errors.push(...checkRulesDefined(text));
  for (const e of result.errors) console.error(e);
  if (process.argv.includes('--summary')) {
    console.log(JSON.stringify(result.summary, null, 2));
    const matrix = {};
    for (const r of result.rows) {
      matrix[r.section] ??= {};
      const key = `${r.cls ?? '?'} / ${r.pri}`;
      matrix[r.section][key] = (matrix[r.section][key] ?? 0) + 1;
    }
    console.log(JSON.stringify(matrix, null, 2));
  }
  console.log(`${result.rows.length} dòng, ${result.errors.length} lỗi`);
  process.exit(result.errors.length === 0 ? 0 : 1);
}
