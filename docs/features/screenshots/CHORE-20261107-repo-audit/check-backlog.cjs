// TC-CHORE-04 (CHORE-20261107-repo-audit): so khớp docs/BACKLOG.md với trạng thái PR trên GitHub. Chỉ đọc.
// Chạy từ gốc repo: node docs/features/screenshots/CHORE-20261107-repo-audit/check-backlog.cjs [--cache file.json]
// Cần `gh` đã đăng nhập. --cache: lưu hoặc dùng lại dữ liệu PR đã tải (lần chạy đầu tải ~50 PR, mất khoảng một phút).
// Exit 0: không có lỗi. Exit 1: in từng lỗi.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { group } = require('./group-bl160.cjs');

// Mốc của task: chỉ tính PR merge tới aeee9c9 (push main lúc 2026-11-07T01:39:54Z).
const UNTIL = '2026-11-07T01:40:00Z';
const EXEMPT = new Set([28]); // #28: 0 file, head là main; miễn điều kiện review (G2 #1)

const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));

function loadPrs(cacheFile) {
  if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const list = gh(['pr', 'list', '--state', 'merged', '--limit', '300', '--json', 'number,mergedAt,title,headRefName']);
  const prs = list
    .filter((p) => p.mergedAt <= UNTIL)
    .map((p) => ({
      ...p,
      ...gh(['pr', 'view', String(p.number), '--json', 'author,reviews,commits,files']),
    }));
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(prs));
  return prs;
}

// Review hợp lệ: người review không phải tác giả và không có commit trong PR (CONTRIBUTING §1.4).
function validReviews(pr) {
  const committers = new Set(pr.commits.flatMap((c) => c.authors.map((a) => a.login)));
  return pr.reviews.filter((r) => r.author.login !== pr.author.login && !committers.has(r.author.login));
}

function rows(md) {
  return md
    .split('\n')
    .filter((l) => /^\| BL-\d{3} \|/.test(l))
    .map((l) => {
      const c = l.split(' | ');
      return { id: c[0].slice(2), text: c[1], source: c[2], line: l };
    });
}

const prRefs = (s) => [...s.matchAll(/(?:PR #|pull\/|PR\s+#?)(\d+)/g)].map((m) => Number(m[1]));
const taskRefs = (s) => [...s.matchAll(/features\/((?:DBS|FRAUD-API)-\d+)-/g)].map((m) => m[1]);
// Câu "đang chờ merge/review" chỉ đúng khi PR chưa merge.
const PENDING = /review (và|hoặc) merge|merge main|chưa merge|PR chưa mở|Draft PR|trước khi merge|Cần merge|PR đã merge vào main, CI xanh, Dev review/i;

function main() {
  const i = process.argv.indexOf('--cache');
  const prs = loadPrs(i > 0 ? process.argv[i + 1] : null);
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const byTask = new Map();
  for (const p of prs) {
    const m = `${p.title} ${p.headRefName}`.match(/(DBS|FRAUD-API)[-_ ]?(\d+)/i);
    if (m) byTask.set(`${m[1].toUpperCase()}-${m[2].padStart(m[1].toUpperCase() === 'FRAUD-API' ? 2 : 1, '0')}`, p.number);
  }
  const md = fs.readFileSync(path.join('docs', 'BACKLOG.md'), 'utf8');
  const errors = [];

  for (const r of rows(md)) {
    if (r.id === 'BL-160') continue;
    const merged = prRefs(r.text).filter((n) => byNumber.has(n));
    const viaTask = taskRefs(r.source).map((t) => byTask.get(t)).filter(Boolean);
    if (PENDING.test(r.text) && (merged.length || viaTask.length))
      errors.push(`${r.id}: ghi đang chờ merge/review/mở PR nhưng PR ${[...new Set([...merged, ...viaTask])].map((n) => '#' + n).join(', ')} đã merge`);
    for (const n of merged)
      if (validReviews(byNumber.get(n)).length)
        errors.push(`${r.id}: PR #${n} đã merge và có review hợp lệ; kiểm phần còn lại của điều kiện đóng`);
  }

  // BL-014: đóng khi lần chạy push main đầu tiên của ci.yml xanh.
  const runs = gh(['run', 'list', '--workflow', 'ci.yml', '--event', 'push', '--branch', 'main', '--limit', '300', '--json', 'conclusion,createdAt']);
  const first = runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (first && first.conclusion === 'success' && /^\| BL-014 \|/m.test(md))
    errors.push('BL-014: lần chạy push main đầu tiên đã xanh nhưng dòng vẫn còn');

  // BL-160: danh sách khớp script nhóm, mọi PR (trừ #28) chưa có review hợp lệ.
  const bl160 = rows(md).find((r) => r.id === 'BL-160');
  if (!bl160) errors.push('BL-160: không có dòng');
  else {
    const g = group(prs);
    const part = (label) => {
      const m = bl160.text.match(new RegExp(`\\*\\*${label} \\((\\d+)\\):\\*\\* ([^*(]*)`));
      return m ? { count: Number(m[1]), list: [...m[2].matchAll(/#(\d+)/g)].map((x) => Number(x[1])) } : null;
    };
    for (const [label, key] of [['Đường tiền', 'money'], ['Code khác và skill', 'other'], ['Chỉ docs', 'docs']]) {
      const p = part(label);
      const want = g[key];
      if (!p) errors.push(`BL-160: thiếu nhóm "${label}"`);
      else if (p.count !== want.length || p.list.join(',') !== want.join(','))
        errors.push(`BL-160 nhóm "${label}": ghi ${p.list.join(',')} (${p.count}), script ra ${want.join(',')} (${want.length})`);
    }
    for (const p of prs)
      if (!EXEMPT.has(p.number) && validReviews(p).length)
        errors.push(`BL-160: PR #${p.number} đã có review hợp lệ, phải bỏ khỏi danh sách`);
  }

  console.log(`${prs.length} PR đã merge tới ${UNTIL}; ${rows(md).length} dòng BL`);
  for (const e of errors) console.log('LỖI ' + e);
  console.log(errors.length ? `${errors.length} lỗi` : 'đạt');
  process.exit(errors.length ? 1 : 0);
}

main();
