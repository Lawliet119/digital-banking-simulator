// DBS-141: phân loại từng dòng BACKLOG. Nguồn duy nhất của ba cột «Ưu tiên», «Xử lý», «Hạn» và của bảng ở feature doc §2.4.
// Mã quy tắc và ưu tiên cho phép: RULES trong .claude/skills/dbs-delivering-task/scripts/check-backlog.mjs.
// Mỗi dòng: [mã, lý do ngắn, tùy chọn]; tùy chọn: { task: 'DBS-166' | ['DBS-187','DBS-188'], pri, due }.
// Mức mặc định theo mã; `pri` ghi đè (trong tập cho phép) khi có lý do ghi ở cột «lý do» (cổng đã trễ, hạn cứng, task Highest).

/** Tuần của các task board được trích làm hạn (fetch-task.mjs, 2026-11-20). Tuần 8 = 19–25/11/2026 (DBS-153 §3). */
export const WEEK = {
  'DBS-166': 7, 'DBS-167': 7, 'DBS-169': 7, 'DBS-175': 7, 'DBS-178': 7,
  'DBS-187': 8, 'DBS-188': 8, 'DBS-190': 9, 'DBS-202': 10, 'DBS-208': 10,
};

const BEFORE_LOAD = 'Trước DBS-166 (tuần 7)';
const BEFORE_HOLDOUT = 'Trước DBS-169 (tuần 7)';
const EVIDENCE = 'Trước DBS-202 (tuần 10)';
const none = 'Không có';

/** Hạn mặc định theo mã; dòng có thể ghi đè bằng `due`. */
export function defaultDue(code, task) {
  const last = Array.isArray(task) ? task[task.length - 1] : task;
  if (code === 'L' || code === 'H6') return `${last} (tuần ${WEEK[last]})`;
  if (code === 'T1' || code === 'T2' || code === 'T3' || code === 'T4') return BEFORE_LOAD;
  if (code === 'H3' || code === 'H4') return EVIDENCE;
  return none;
}

export const MAP = {
  // Dev
  'BL-042': ['H5', 'giao diện risk chưa có; không chặn tải'],
  'BL-121': ['H2', 'lỗi harness test, chưa tái hiện'],
  'BL-125': ['H2', 'crash native Windows của bộ test DB'],
  'BL-135': ['H3', 'bước thử trên trình duyệt do người chạy'],
  'BL-179': ['L', 'ngưỡng rate limit chốt theo số đo tải của DBS-166 (task Highest)', { task: 'DBS-166', pri: 'Cao' }],
  'BL-190': ['H3', 'nộp P2: người nộp, hạn ngoài tải'],
  'BL-191': ['H2', 'lỗi launcher Windows'],
  'BL-192': ['H2', 'lỗi launcher Windows'],
  'BL-198': ['H4', 'chạy luồng tiền trên cloud: kiểm bổ sung, không chặn tải'],
  'BL-199': ['H4', 'negative control CI của DBS-65, bằng chứng bổ sung'],
  'BL-200': ['H2', 'crash native Windows, đã chạy được trên Node 24.22.2'],
  'BL-215': ['H4', 'thử khi Docker tắt thật, bổ sung kiểm'],
  'BL-218': ['H4', 'chạy worker thật kill/restart, bổ sung kiểm'],
  'BL-220': ['H4', 'drill thu hồi phiên trên cloud, bổ sung kiểm'],
  'BL-221': ['L', 'đo p95 đọc khi Redis chậm: chính là DBS-167', { task: 'DBS-167' }],
  'BL-222': ['H4', 'kiểm quy tắc iat trên cloud, bổ sung kiểm'],
  'BL-231': ['H2', 'crash native Windows của bộ test DB'],
  'BL-233': ['H4', 'ảnh và kiểm harness của k6 local'],
  'BL-235': ['H5', 'giao diện web tùy chọn'],
  'BL-240': ['H4', 'chạy lại EXPLAIN trên dữ liệu thật hơn, sau tải'],
  'BL-262': ['L', 'ảnh console dashboard lúc chạy tải thuộc DBS-178', { task: 'DBS-178' }],
  'BL-279': ['H3', 'review của Dev khác cho PR #178 đã merge'],
  'BL-283': ['H1', 'chiều môi trường chỉ cần khi dev và prod chạy cùng lúc'],
  'BL-381': ['T4', 'SIGTERM giữa transaction trả 500; triển khai lúc tải chạm tới'],
  'BL-384': ['H4', 'đo lại mã thoát/thời gian dừng worker trên cloud'],
  'BL-402': ['H5', 'nối check-backlog.mjs vào CI, tùy chọn'],
  'BL-400': ['H5', 'nhớ lượt chạy trước của dlq:resend, tùy chọn'],
  // Fraud
  'BL-040': ['H3', 'cập nhật board và xác nhận guide: người quản lý board'],
  'BL-041': ['H4', 'bàn giao tập tune (backend/data/fraud/ chưa có) và đối chiếu parity'],
  'BL-043': ['T3', 'duyệt dữ liệu và egress trước khi gửi cho API AI; hạn theo holdout', { due: BEFORE_HOLDOUT }],
  'BL-044': ['H4', 'đo B0/B1/B2 gồm phần AI mà DBS-169, 170 không phủ hết'],
  'BL-050': ['H3', 'owner tài liệu xác nhận ADR-14'],
  'BL-138': ['H3', 'xác nhận chữ ký Features/RuleParams giữa các vai'],
  'BL-171': ['T3', 'nơi lưu nhãn holdout quyền riêng, bảo vệ bức tường dữ liệu; hạn theo holdout', { due: BEFORE_HOLDOUT }],
  'BL-173': ['H6', 'giới hạn bộ mixed ghi ở P5 (DBS-190)', { task: 'DBS-190' }],
  'BL-187': ['L', 'đo p95 extract fraud ở 120 extract/s trên RDS: tài khoản nóng của DBS-166', { task: 'DBS-166', pri: 'Cao' }],
  'BL-188': ['H4', 'chạy thật verify-worker-rollout và thư SNS'],
  'BL-236': ['H4', 'chạy export-features trên tập tune thật (chờ backend/data/fraud/, BL-041); hạn đổi theo kiểm mù M-141-05', { due: 'Sau BL-041' }],
  'BL-238': ['H4', 'chạy parity trên tập tune thật (chờ backend/data/fraud/)'],
  'BL-340': ['H6', 'counter cờ/1.000 giao dịch và alarm thuộc DBS-187, DBS-188', { task: ['DBS-187', 'DBS-188'] }],
  'BL-391': ['H4', 'phát hiện còn lại của audit dataset DBS-146'],
  'BL-392': ['T3', 'hợp đồng kịch bản nằm trong docs/ nơi #4 đọc được; hạn theo holdout', { due: BEFORE_HOLDOUT }],
  // Platform & Ops
  'BL-027': ['H3', 'người thứ hai chạy terraform init với bucket state'],
  'BL-029': ['H4', 'runbook teardown bucket state: DBS-208 chỉ quyết giữ hay xóa, không viết và chạy runbook', { due: 'DBS-208 (tuần 10)' }],
  'BL-033': ['H5', 'thêm ngưỡng budget 150 USD'],
  'BL-037': ['H1', 'ACM công khai chỉ cần cho môi trường thật'],
  'BL-104': ['T1', 'Deploy thật là đường đưa image lên cloud: còn thiếu biến AWS_DEPLOY_ROLE_ARN (Image đã xanh)'],
  'BL-105': ['H4', 'kiểm OIDC và từ chối workflow khác: việc sau khi BL-104 chạy Deploy', { due: 'Sau BL-104' }],
  'BL-109': ['T1', 'migration lỗi và Deploy thật trước khi chạy cloud'],
  'BL-117': ['H4', 'kích thử alarm Redis khi có phiên'],
  'BL-127': ['L', 'invariants.txt đi kèm mọi lượt tải: DoD của DBS-166 (task Highest)', { task: 'DBS-166', pri: 'Cao' }],
  'BL-182': ['T4', 'alarm outbox-age phát hiện mất worker sau 9 phút; phần đo lô relay dưới tải thuộc DBS-175'],
  'BL-216': ['L', 'drill Redis chậm/chết dưới tải: DBS-167', { task: 'DBS-167' }],
  'BL-232': ['L', 'nghiệm thu 5 script k6 trên cloud: chính là DBS-166 (task Highest)', { task: 'DBS-166', pri: 'Cao' }],
  'BL-247': ['H4', 'chạy nhóm B của DBS-121 trên AWS; image đã có trong ECR (Image xanh)'],
  'BL-251': ['T1', 'đo dựng từ trống ≤ 30 phút (DBS-139)'],
  'BL-252': ['T1', 'seed cloud thật bằng seed-cloud.sh (đường qua ALB đã thay)'],
  'BL-264': ['T3', 'CVE CRITICAL trên image dbs-api'],
  'BL-265': ['T1', 'IAM user dev1 không dựng được phiên cloud'],
  'BL-280': ['H1', 'dựng envs/prod'],
  'BL-281': ['H1', 'pipeline, alarm, WAF cho prod'],
  'BL-282': ['H1', 'tách Cognito và SG của prod'],
  'BL-284': ['H1', 'CMK riêng cho prod'],
  'BL-285': ['H1', 'đồng bộ dev/prod và max_connections của prod'],
  'BL-290': ['T2', 'phần (2) đổi miễn rate rule WAF về [] cùng cơ chế BL-292; phần chi phí là H4'],
  'BL-291': ['H5', 'tắt WAF sau tuần 8 để giảm chi phí; hạn cứng 2026-11-26', { pri: 'Trung bình', due: '2026-11-26' }],
  'BL-292': ['T2', 'miễn rate rule WAF cho IP k6 trước khi chạy k6'],
  'BL-293': ['H5', 'cải tiến WAF ngoài phạm vi'],
  'BL-300': ['H1', 'CMK cho log, ECR, SNS, state: mức bảo mật production'],
  'BL-301': ['H1', 'tách CMK theo dịch vụ/prod'],
  'BL-302': ['T1', 'xoay secret và dựng mới dưới key policy DBS-154 trên AWS'],
  'BL-324': ['H5', 'alarm nhắc tắt Multi-AZ'],
  'BL-325': ['H4', 'kiểm dữ liệu qua chuyển Single/Multi-AZ'],
  'BL-326': ['H4', 'kiểm destroy khi Multi-AZ'],
  'BL-341': ['H4', 'kích thử 18 alarm trên AWS khi có phiên'],
  'BL-350': ['H4', 'script đăng ký khách cho demo cloud'],
  'BL-361': ['T3', '.gitignore chưa chặn file chứa body sự kiện và handle'],
  'BL-362': ['H4', 'đường đọc processed_events cho Ops'],
  'BL-363': ['H4', 'kiểm danh sách quyền tối thiểu của runbook DLQ'],
  'BL-382': ['T2', 'quyết định số task api khi chạy; RTO ≈ 2 phút'],
  'BL-385': ['L', 'đo p95 120 RPS khi consumer lỗi: kịch bản k6 của DBS-166 (task Highest)', { task: 'DBS-166', pri: 'Cao' }],
  'BL-386': ['H4', 'diễn tập failover có probe và video'],
  'BL-388': ['H4', 'diễn tập PITR/snapshot'],
  'BL-394': ['H4', 'diễn tập rollback revision INACTIVE'],
  'BL-395': ['H1', 'role vận hành riêng cho rollback'],
  'BL-396': ['T4', 'revision cũ còn ACTIVE có thể bị chọn nhầm khi rollback'],
  'BL-274': ['H4', 'đo đường thật của alarm đối soát khi có phiên'],
  'BL-275': ['T4', 'alarm đối soát không bắt worker chết hay lỗi trước khóa'],
  'BL-276': ['T4', 'chưa nhận thư SNS thật khi alarm kêu'],
  'BL-277': ['H4', 'đo chu kỳ đối soát trên dataset lớn để chọn chu kỳ production'],
  'BL-397': ['H4', 'terraform apply thật cho RSK-03 và nạp khóa mới; cần phiên cloud (BL-265); khóa lộ tách sang BL-403', { due: 'Sau BL-265' }],
  'BL-403': ['T3', 'khóa OpenAI lộ ở PR #45 chưa thu hồi; chỉ cần tài khoản OpenAI', { due: 'Ngay' }],
  'BL-398': ['H4', 'kích thử hai alarm RSK-04 trên AWS'],
  'BL-399': ['H4', 'chạy dlq:resend trên SQS AWS thật'],
  // Người thật và quay video
  'BL-228': ['H3', 'người bấm giờ M-135-05; đóng cùng BL-390', { due: 'Sau BL-390' }],
  'BL-351': ['H3', 'người nhóm chạy kịch bản giữa kỳ; đóng cùng BL-390', { due: 'Sau BL-390' }],
  'BL-380': ['H3', 'quay video AC-5.10 trên cloud'],
  'BL-383': ['H3', 'quay incident-cloud.sh liền mạch'],
  'BL-387': ['H3', 'luyện câu bảo vệ 7 trước tổng duyệt DBS-199', { due: 'Trước DBS-199 (tuần 9)' }],
  'BL-390': ['H3', 'cổng tuần 5 đã trễ 3 tuần; là điều kiện của DBS-141 DoD 1', { pri: 'Cao', due: 'Tuần 5 (đã trễ)' }],
  'BL-393': ['H3', 'quay drill rollback'],
  'BL-401': ['H3', 'dòng mới của task này: gom vấn đề của buổi quay và gửi cả nhóm', { due: 'Sau BL-390' }],
};
