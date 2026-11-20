// DBS-141: thêm ba cột «Ưu tiên», «Xử lý», «Hạn» vào docs/BACKLOG.md từ classification.mjs, thêm bảng mã vào đầu file,
// xóa BL-278 (đã xử lý), sửa chữ vài dòng lỗi thời, chuyển BL-397/398 về mục Platform & Ops, thêm BL-401, 402, 403, sắp ID tăng dần.
// Chạy một lần từ gốc repo:   node docs/features/screenshots/DBS-141/apply-classification.mjs --base <ref> [--write]
// Đọc bản 5 cột gốc từ git (`git show <ref>:docs/BACKLOG.md`; --base bắt buộc), không đọc working tree, nên chạy lại được.
// Không có --write thì in bảng phân loại (markdown) cho feature doc §2.4.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MAP, defaultDue } from './classification.mjs';
import { RULES } from '../../../../.claude/skills/dbs-delivering-task/scripts/check-backlog.mjs';

const path = 'docs/BACKLOG.md';
const write = process.argv.includes('--write');
const baseIdx = process.argv.indexOf('--base');
const base = baseIdx >= 0 ? process.argv[baseIdx + 1] : undefined;
if (!base) throw new Error('Cần --base <ref>: commit chứa bản 5 cột gốc của docs/BACKLOG.md (sau khi commit kết quả, HEAD đã là bản 8 cột).');
const text = execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' }).replace(/\r/g, '');
const lines = text.split('\n');

const DELETE = new Set(['BL-278']);
/** Sửa chữ: [cột, cũ, mới]; cột ∈ work, src, role, done; cũ = null thì thay cả ô. Cũ phải có trong ô, nếu không thì dừng. */
const PATCH = {
  'BL-279': [
    ['work', 'DBS-123 DoD 3: chưa push, chưa PR, chưa Dev khác review, bảng «Đối chiếu test case» chưa điền trong PR; board chưa chuyển trạng thái', 'DBS-123 DoD 3: PR #178 đã merge vào `main` (CI xanh, board Done) nhưng chưa có Dev khác review và bảng «Đối chiếu test case» chưa điền trong PR'],
    ['done', 'PR merge vào `main`, CI xanh, review kèm bảng đối chiếu điền đủ', 'Dev khác review PR #178 và điền bảng đối chiếu, hoặc techlead ghi nhận chấp nhận bản đã merge'],
  ],
  'BL-397': [
    ['work', null, 'RSK-03 trên AWS thật (PR RSK-03 đã merge ở #213 theo techlead; Dev khác chưa review): chạy `terraform apply` cho `dev/base` & `dev/session` và nạp khóa OpenAI mới (raw string) vào `dbs/dev/openai-api-key`. Việc thu hồi khóa lộ ở PR #45 tách sang BL-403.'],
    ['done', null, '`terraform plan`/`apply` sạch trên AWS thật, khóa mới nằm trong `dbs/dev/openai-api-key`, Dev khác đã review PR #213'],
  ],
  'BL-398': [
    ['work', 'Dev review và merge PR RSK-04.', '(PR RSK-04 đã merge ở #214 theo techlead; Dev khác chưa review).'],
    ['done', 'PR đã review và merge `main`', 'Dev khác đã review PR #214'],
  ],
  'BL-104': [
    ['work', 'push `main` thật để `Image` rồi `Deploy` xanh', '`Image` đã xanh trên `main` (2026-11-20) còn `Deploy` đang `skipped` vì chưa có biến `AWS_DEPLOY_ROLE_ARN`: tạo biến rồi chạy `Deploy` xanh'],
    ['work', 'Chủ repo cần tạo biến `AWS_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`.', 'Chủ repo cần tạo biến `AWS_DEPLOY_ROLE_ARN` (`AWS_ROLE_ARN` đã có).'],
  ],
  'BL-105': [['role', '#5 Platform & Ops (khi có prod)', '#5 Platform & Ops']],
  'BL-247': [
    ['work', 'cần image `<sha>` trong ECR.', 'image `<sha>` đã có trong ECR từ workflow `Image` xanh trên `main`.'],
    ['done', 'Có image trong ECR; chạy §5 nhóm B', 'Chạy §5 nhóm B'],
  ],
  'BL-251': [['work', '`seed --auth cloud`', '`seed-cloud.sh`']],
  'BL-252': [
    ['work', 'Seed dữ liệu demo qua ALB cloud (`npm run seed -- --auth cloud`): ALB dev dùng chứng chỉ tự ký CN `dbs-dev.local`, Node từ chối TLS và Terraform không xuất chứng chỉ để tin cậy.', 'Chạy `infra/scripts/seed-cloud.sh` một lần trên AWS thật (seed trong VPC; đường qua ALB của `npm run seed -- --auth cloud` bị chứng chỉ tự ký CN `dbs-dev.local` chặn, đã thay theo [DBS-70](features/DBS-70-seed-demo-data.md) §8.3).'],
    ['done', null, '`seed-cloud.sh` chạy thật trên AWS dev thành công (sau `apply base`, `apply session` và image build); ghi output vào feature doc'],
  ],
  'BL-291': [['work', 'cảnh báo từ `2026-11-26`.', 'cảnh báo từ `2026-11-26`. Cần quyết cùng BL-290 và BL-292: WAF bật hay tắt trong lượt tải DBS-166 (nếu tải chạy sau 2026-11-26 với WAF tắt thì BL-292 và phần (2) của BL-290 hết áp dụng).']],
  'BL-292': [['work', 'nếu không loại trừ.', 'nếu không loại trừ. Phụ thuộc quyết định WAF ở BL-291.']],
};
const NEW_ROWS = {
  Dev: [
    ['BL-402', 'Nối `check-backlog.mjs` vào workflow CI (job `script-tests` hoặc job riêng) để một PR làm sai bảng `docs/BACKLOG.md` bị chặn; hiện chỉ chạy tay ở Phase 5 của skill.', '[DBS-141](features/DBS-141-post-demo-tech-debt.md) §3, §8', 'Dev', 'Workflow CI chạy `node --test` của `check-backlog.test.mjs` và `check-backlog.mjs` trên `docs/BACKLOG.md`; một PR cố ý làm sai bảng bị đỏ'],
  ],
  'Platform & Ops': [
    ['BL-403', 'Thu hồi khóa OpenAI bị lộ ở PR #45 trên trang OpenAI (khóa mới do chủ tài khoản tạo, nạp vào `dbs/dev/openai-api-key` ở BL-397).', '[RSK-03](features/RSK-03-ai-api-infra.md) §8; [DBS-141](features/DBS-141-post-demo-tech-debt.md) §2.3', 'Chủ tài khoản OpenAI (#5 Platform & Ops theo dõi)', 'Khóa của PR #45 hiển thị đã thu hồi trên OpenAI; ngày thu hồi ghi vào feature doc RSK-03'],
  ],
  'Người thật và quay video': [
    ['BL-401', 'Sau khi quay video giữa kỳ (BL-390): ghi mọi vấn đề thấy khi chạy thử và quay thành dòng BACKLOG đủ 8 cột (DBS-141 DoD 1 chưa đạt vì chưa có buổi quay), rồi gửi danh sách này cho cả nhóm (DBS-141 DoD 2).', '[DBS-141](features/DBS-141-post-demo-tech-debt.md) §8', 'Dev (người quay) và người gom (#2)', 'Mọi vấn đề của buổi quay có một dòng BACKLOG hoặc được ghi «không có vấn đề»; danh sách đã gửi cả nhóm (ngày ghi ở feature doc DBS-141)'],
  ],
};
const MOVE = { 'BL-397': 'Platform & Ops', 'BL-398': 'Platform & Ops' };


const cell = line => line.trim().split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim());
const sections = []; // { title, head: [lines before table], rows: [cells5], tail: [lines after table] }
let cur = { title: '__preamble__', pre: [], rows: [], post: [] };
sections.push(cur);
let inTable = false;
for (const line of lines) {
  const h = /^## (.+)$/.exec(line);
  if (h) {
    cur = { title: h[1].trim(), pre: [line], rows: [], post: [] };
    sections.push(cur);
    inTable = false;
    continue;
  }
  if (/^\| ID \|/.test(line)) {
    inTable = true;
    continue;
  }
  if (inTable && /^\|---/.test(line)) continue;
  if (inTable && /^\| BL-\d{3} \|/.test(line)) {
    cur.rows.push(cell(line));
    continue;
  }
  (inTable ? cur.post : cur.pre).push(line);
}
const byTitle = prefix => sections.find(s => s.title.startsWith(prefix));

// xóa, sửa, chuyển, thêm
for (const s of sections) {
  s.rows = s.rows.filter(r => !DELETE.has(r[0]));
  for (const r of s.rows) {
    for (const [col, oldT, newT] of PATCH[r[0]] ?? []) {
      const i = { work: 1, src: 2, role: 3, done: 4 }[col];
      if (oldT === null) r[i] = newT;
      else {
        if (!r[i].includes(oldT)) throw new Error(`${r[0]}: không thấy «${oldT.slice(0, 40)}…» trong cột ${col}`);
        r[i] = r[i].replace(oldT, () => newT);
      }
    }
  }
}
for (const [id, target] of Object.entries(MOVE)) {
  for (const s of sections) {
    const i = s.rows.findIndex(r => r[0] === id);
    if (i >= 0 && !s.title.startsWith(target)) byTitle(target).rows.push(...s.rows.splice(i, 1));
  }
}
for (const [title, rows] of Object.entries(NEW_ROWS)) byTitle(title).rows.push(...rows);
for (const s of sections) s.rows.sort((a, b) => a[0].localeCompare(b[0]));

// ba cột mới
const table = [];
const seen = new Set();
for (const s of sections)
  for (const r of s.rows) {
    const [id] = r;
    const entry = MAP[id];
    if (!entry) throw new Error(`${id}: thiếu trong classification.mjs`);
    const [code, why, opt = {}] = entry;
    const rule = RULES[code];
    if (!rule) throw new Error(`${id}: mã ${code} lạ`);
    const pri = opt.pri ?? rule.defaultPri;
    if (!rule.allowed.includes(pri)) throw new Error(`${id}: ${code} không cho ưu tiên ${pri}`);
    const task = opt.task ? (Array.isArray(opt.task) ? opt.task : [opt.task]) : undefined;
    if (Boolean(rule.needsTask) !== Boolean(task)) throw new Error(`${id}: mã ${code} ${rule.needsTask ? 'cần' : 'không được có'} task`);
    const fix = `${rule.cls} · ${code}${task ? ` (${task.join(', ')})` : ''}`;
    const due = opt.due ?? defaultDue(code, task);
    r.push(pri, fix, due);
    seen.add(id);
    table.push({ id, section: s.title.split(' ')[0], code: task ? `${code} (${task.join(', ')})` : code, cls: rule.cls, pri, due, why });
  }
for (const id of Object.keys(MAP)) if (!seen.has(id)) throw new Error(`${id}: có trong classification.mjs nhưng không có trong BACKLOG`);

const HEADER_BLOCK = `## Phân loại: ưu tiên, xử lý, hạn (DBS-141)

Mỗi dòng có ba cột cuối. **Xử lý** = «nhóm · mã». **Ưu tiên** ∈ {Cao, Trung bình, Thấp}: mức mặc định theo mã; một dòng được nâng hoặc hạ trong tập cho phép khi có lý do (cổng đã trễ, hạn cứng, task Highest), lý do ghi ở feature doc của dòng. **Hạn** là một task board kèm tuần, một ngày, «Ngay», «Sau BL-nnn», hoặc «Không có» (ghi nhận, chưa có hạn).

| Mã | Nhóm | Ưu tiên mặc định | Áp khi |
|---|---|---|---|
| T1 | Trước tải | Cao | chặn dựng hoặc chạy phiên cloud: quyền, credential, image/deploy, seed, dựng từ trống |
| T2 | Trước tải | Trung bình | quyết định, cấu hình hoặc việc phải có sẵn **trước** khi chạy tải (miễn WAF cho k6, số task api, chọn chu kỳ) |
| T3 | Trước tải | Cao | rủi ro bảo mật hoặc rò dữ liệu đang mở (CVE nghiêm trọng, khóa lộ, nhãn holdout, file chứa body sự kiện) |
| T4 | Trước tải | Trung bình | lỗi hoặc lỗ hổng giám sát của thứ đang chạy mà lượt tải hoặc diễn tập sẽ chạm |
| L | Trong tải | Trung bình | việc là một phần của task tải trên board hoặc do task đó tạo ra; **bắt buộc nêu task**, ví dụ \`Trong tải · L (DBS-166)\`; hạn là hạn của task |
| H1 | Hoãn | Thấp | chỉ cần cho \`envs/prod\` hoặc mức bảo mật production |
| H2 | Hoãn | Thấp | điều tra lỗi công cụ cục bộ (Windows) đã có cách tránh |
| H3 | Hoãn | Trung bình | việc của người thật: quay, luyện, bấm giờ, duyệt, xác nhận chéo |
| H4 | Hoãn | Trung bình | đo hoặc chạy kiểm bổ sung trên dữ liệu hoặc cloud thật, sau khi có phiên và số đo |
| H5 | Hoãn | Thấp | cải tiến tùy chọn hoặc giảm chi phí |
| H6 | Hoãn | Thấp | một task board khác đã nhận trọn việc này; **bắt buộc nêu task**, ví dụ \`Hoãn · H6 (DBS-187, DBS-188)\` |

Thứ tự áp mã đầu tiên khớp: T1, T3, T2, T4, L, H1…H6. «Trước tải» = trước các task tải DBS-166, 167, 173, 174, 175, 178, 179. Tuần 8 = 19–25/11/2026 (tuần khác cộng hoặc trừ 7 ngày, theo [DBS-153](features/DBS-153-waf-alb.md) §3).

- **Dòng mới** điền cả ba cột; vai đứng đầu trong «Vai đề xuất» là người nhận. Mục «Người thật và quay video» là một loại việc (cần người thật), không phải một vai. Chạy \`node .claude/skills/dbs-delivering-task/scripts/check-backlog.mjs\` trước khi mở PR: phải sạch.
- **Rà lại:** khi DBS-166 xong, hoặc khi DBS-200 (đóng băng code) bắt đầu, mỗi dòng còn «Trước tải» hoặc «Trong tải» được đóng, hoặc đổi sang «Hoãn» kèm lý do ở feature doc của task làm việc đó.
- Danh sách này là nơi gom nợ kỹ thuật (thay cho issue \`tech-debt\`); vấn đề mới của buổi quay video giữa kỳ vào đây theo BL-401.
`;

const out = [];
for (const s of sections) {
  if (s.title === '__preamble__') {
    out.push(...s.pre);
    continue;
  }
  if (s.title.startsWith('Dev')) out.push(...HEADER_BLOCK.split('\n'));
  out.push(...s.pre);
  out.push('| ID | Việc còn thiếu | Nguồn | Vai đề xuất | Đóng khi | Ưu tiên | Xử lý | Hạn |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const r of s.rows) out.push(`| ${r.join(' | ')} |`);
  out.push(...s.post);
}
let result = out.join('\n').replace('**Cập nhật:** 2026-11-15', '**Cập nhật:** 2026-11-20 (DBS-141: ưu tiên, xử lý, hạn)');

if (write) writeFileSync(path, result);
else {
  console.log('| Dòng | Mục | Mã | Nhóm · Ưu tiên | Hạn | Lý do |\n|---|---|---|---|---|---|');
  for (const r of table) console.log(`| ${r.id} | ${r.section} | ${r.code} | ${r.cls} · ${r.pri} | ${r.due} | ${r.why} |`);
}
console.error(`${table.length} dòng${write ? ' (đã ghi)' : ''}`);
