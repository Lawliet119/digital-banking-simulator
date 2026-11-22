"""DBS-189: mỗi con số trong docs/deliverables/P4-production-engineering.md phải khớp tài liệu gốc.
Mỗi kiểm tra là một CẶP: chuỗi trong bản ghép (số kèm chỉ số nó thuộc về) và chuỗi trong nguồn. Thiếu một trong hai là FAIL,
nên đổi số trong bản ghép (kể cả số không nằm trong danh sách cũ) sẽ làm một cặp trượt.
Thêm: bảng SLO của bản ghép phải trùng từng dòng với docs/03 §14; số ảnh dashboard đếm từ thư mục.
Chạy ở thư mục gốc repo: PYTHONUTF8=1 python docs/features/screenshots/DBS-189/verify-numbers.py
Đổi bản ghép để thử ca trượt: P4_BUNDLE=<đường dẫn> (M-189-02). Thoát 0 khi mọi cặp khớp, 1 nếu có FAIL.
"""
import os
import sys

BUNDLE = os.environ.get('P4_BUNDLE', 'docs/deliverables/P4-production-engineering.md')
L = 'docs/components/load-tests/'
R02, R03, R04, R05 = (L + '02-ket-qua-tai-cloud-2026-11-21.md', L + '03-ket-qua-toi-uu-p95-2026-11-21.md',
                      L + '04-ket-qua-bl-418-2026-11-22.md', L + '05-ket-qua-redis-2026-11-22.md')
INC = 'docs/deliverables/P4-incident-table.md'
CAP = 'docs/components/platform-infra/02-capacity-cost.md'
REP = 'docs/components/platform-infra/cost-reports/2026-11-22.md'
D03 = 'docs/03_HIGH_LEVEL_ARCHITECTURE.md'
D181 = 'docs/features/screenshots/DBS-181/manual-test.txt'
D178 = 'docs/features/DBS-178-dashboard-complete.md'

# (chuỗi trong bản ghép, tệp nguồn, chuỗi trong nguồn)
CHECKS = [
    # §2.1 bốn lần đo baseline
    ('218,2 / 703,2', R03, '36,7 / 218,2 / 703,2'),
    ('344,0 / 1.406,0', R03, '36,5 / 344,0 / 1.406,0'),
    ('262,4 / 850,9', R03, '31,9 / **262,4** / **850,9**'),
    ('**91,9 / 585,5**', R04, 'p95 **91,9 ms**'),
    ('**91,9 / 585,5**', R04, 'p99 585,5 ms'),
    ('171 (0,158 %) / 54', R03, '171 / 0,158% / 54'),
    ('1 (0,0009 %) / 0', R03, '**1 / 0,0009% / 0**'),
    ('9 (0,0083 %) / 1', R04, '9 lỗi timeout (0,0083%) và 1 dropped iteration'),
    ('chỉ do 1 dropped; tỉ lệ lỗi vẫn < 0,1 %', R04, '**không đạt** (1 dropped iteration; tỉ lệ lỗi vẫn < 0,1%)'),
    ('3/15 khung (đỉnh 641 ms)', R03, '3 / 15 (đỉnh 641)'),
    ('7/16 khung (đỉnh 1.985 ms)', R03, '7 / 16 (đỉnh 1.985)'),
    ('5/16 khung (đỉnh 678 ms)', R03, '**5 / 16 (đỉnh 678)**'),
    ('**2/15 khung** (442 và 377 ms)', R04, '(442 và 377 ms)'),
    ('chuyển **42 / 60 ms** (p99 106 / 153 ms)', R02, 'chuyển p95 42 / 60 / 218 ms, p99 106 / 153 / 703 ms'),
    ('đọc p95 ≤ 61 ms', R02, 'đọc p95 ≤ 61 ms'),
    ('22,4 → **9,8 ms**', R04, '22,4 → **9,8 ms**'),
    # §2.2
    ('p95 824 ms', R02, 'p95 824 ms'),
    ('299 timeout (1,66 %)', R02, '299 timeout 2 giây (1,66% > 0,1%)'),
    ('p95 52 ms, 0 lỗi', R02, 'p95 52 ms, 0 lỗi'),
    ('p95 **121 ms**', R03, '35 / **121** / 426'),
    ('4 timeout (0,022 %)', R03, '**4 (0,022%)**'),
    ('p95 **2.000 ms**', R03, '93 / **2.000** / 2.001'),
    ('1.881 timeout (10,4 %)', R03, '**1.881 (10,4%)**'),
    ('p95 784 ms', R03, '784 / 1.770'),
    ('43 lỗi (0,119 %)', R03, '43 / 0,119% / 0'),
    ('304,1 ms (hụt 4 ms)', R03, '**304,1 / 996,8**'),
    ('**119,9 ms**', R04, 'p95 **119,9 ms**'),
    ('7 lỗi (0,019 %)', R04, '7 lỗi (0,019%)'),
    ('71 lỗi (0,13 %) **nhưng 105 dropped', R04, '71 (**0,13%**) / 105'),
    ('p95 493 ms** (p95 theo phút tới 1.275 ms)', R04, '493 (p95 theo phút: 226 186 1.275 337 1.245 745)'),
    ('plateau 240 vẫn gãy (68,9 %', R04, '68,9% (trước 98,1%)'),
    ('worker bật gãy 120 → 180 RPS, worker tắt gãy ở 240', R02, 'gãy ở 120 → 180 RPS'),
    ('600 × 201 và 60 × 422', R03, '600 × 201 cùng thân và 60 × 422'),
    ('p95 81 ms', R03, 'p95 81 ms'),
    ('8 lượt ở DBS-166', R02, '8 lượt trên AWS'),
    ('8 ở DBS-173', R03, 'cả 8 lượt trên AWS'),
    ('2 ở BL-418', R04, 'sau cả hai lượt'),
    ('4 ở DBS-167', R05, 'sau cả bốn lượt'),
    # §3 bảng sự cố
    ('p95 chuyển tiền 119 ms', R05, 'p95 chuyển tiền 119 ms'),
    ('breaker mở trong 10 giây đầu', R05, 'Breaker mở trong 10 giây đầu'),
    ('ổn định sau **42,5 giây**', R05, '**42,5 giây**'),
    ('p95 chuyển tiền 203 và 289 ms (SLO 300)', R05, 'p95 chuyển tiền 203 và 289 ms ở hai lượt (SLO 300 ms)'),
    ('đọc 138 và 149 ms (SLO 150)', R05, 'p95 đọc 138 và 149 ms (SLO 150 ms)'),
    ('`history` 142 và **154 ms (vượt 4 ms)**', R05, 'p95 `history` 142 và **154 ms (vượt 4 ms)**'),
    ('ECS gỡ target sau 25 s', INC, 'ECS gỡ target sau 25 s'),
    ('task mới RUNNING sau **131 s**, service ổn định sau **137 s**', INC, 'RUNNING sau **131 s**, service ổn định sau **137 s**'),
    ('**9 phút 5 giây**', INC, 'ALARM` sau **9 phút 5 giây**'),
    ('worker chạy sau 29 s, cờ gian lận sau **43 s**', INC, 'Worker chạy sau **29 s**, cờ 65 MEDIUM sau **43 s**'),
    ('alarm `OK` sau 4 phút 39 giây', INC, 'alarm `OK` sau 4 phút 39 giây'),
    ('vào DLQ sau **2 s**', INC, 'Cả hai vào `dbs-dev-risk-events-dlq` sau **2 s**'),
    ('sau **190 s**', INC, 'sau **190 s**'),
    ('`/health/ready` 503 sau 40 s; sau 197 s', INC, 'Sau 40 s `/health/ready` 503; sau 197 s'),
    ('200 sau 127 s, tổng 267 s', INC, '200 sau 127 s, tổng 267 s'),
    ('khoảng 290 s', INC, 'khoảng 290 s'),
    ('312 ms ở lượt tắt', INC, '(312 ms, đường SQL fallback)'),
    ('**84,3 s**', INC, 'sau **84,3 s**'),
    ('**14,7 s và 12,7 s**', D181, 'Outage window (first 503 -> last 503): 14.7s'),
    ('**14,7 s và 12,7 s**', D181, 'Outage window (first 503 -> last 503): 12.7s'),
    ('thêm hàng Redis dưới tải 120 RPS và failover RDS', INC, '| DBS-181 / AWS dev'),
    # §1 tóm tắt và các số còn lại của §3, §6
    ('**91,9 ms** ở lượt mới nhất, lỗi 0,0083 %', R04, 'p95 **91,9 ms**'),
    ('**91,9 ms** ở lượt mới nhất, lỗi 0,0083 %', R04, '9 lỗi timeout (0,0083%)'),
    ('(2/15 khung vượt)', R04, '**2 khung vượt** (442 và 377 ms)'),
    ('8,2642 USD đã tiêu', REP, '**8,2642**'),
    ('credit còn ≈ 191,29 USD', REP, 'Credit còn lại: 191,2947 USD'),
    ('24/7 dev ≈ 113,23, production ≈ 203,55 USD/tháng; HA thêm 80,14 USD/tháng', CAP, '**113,23** | **203,55**'),
    ('24/7 dev ≈ 113,23, production ≈ 203,55 USD/tháng; HA thêm 80,14 USD/tháng', CAP, '**80,14**'),
    ('ngân sách lỗi 43,2 phút', CAP, '43,2 phút'),
    ('mục tiêu thiết kế 30 phút = 69,44 %', CAP, '69,44 % nếu đúng mục tiêu 30 phút'),
    ('(NACL chặn 6379, 5 phút)', R05, '0 lỗi hệ thống trong 5 phút tắt'),
    ('NACL chặn 6379', R05, 'luật deny tcp 6379'),
    ('mất dịch vụ ≈ 2 phút', INC, 'mất dịch vụ ≈ 2 phút'),
    ('mặc định thì dài hơn khoảng 30 s', 'docs/deliverables/defense-q7-ha-recovery.md', 'lâu hơn ≈ 30 s, BL-382'),
    ('0,60 USD/triệu', CAP, '0,60 USD/triệu'),
    ('0,3330 + WAF cố định 0,0110 = 0,3439', CAP, '× 0,3439 (cấu hình đo cộng WAF cố định)'),
    ('`redis: up` sau 0 và 5,8 giây', R05, 'số của lượt chậm là 0 và 5,8 giây'),
    ('timeout 2 giây, tới 3 giây', R05, 'lúc +265 đến +267 s'),
    # §5 dashboard
    ('**33 widget** (7 văn bản, 1 trạng thái alarm, 25 metric)', D178, '33 widget: 7 `text`, 1 `alarm`, 25 `metric`'),
    # §6 chi phí
    ('**8,2642 USD**', REP, '**8,2642**'),
    ('RDS 1,4266', REP, '| RDS | 1,4266 |'),
    ('WAF 1,0131', REP, '| AWS WAF | 1,0131 |'),
    ('ECS 0,9558', REP, '| ECS | 0,9558 |'),
    ('ALB 0,9283', REP, '| ALB | 0,9283 |'),
    ('KMS 0,8933', REP, '| AWS Key Management Service | 0,8933 |'),
    ('ElastiCache 0,7488', REP, '| ElastiCache | 0,7488 |'),
    ('Secrets 0,7072', REP, '| AWS Secrets Manager | 0,7072 |'),
    ('máy tải 0,5155', REP, '| Amazon Elastic Compute Cloud - Compute | 0,5155 |'),
    ('VPC 0,4700', REP, '| Amazon Virtual Private Cloud | 0,4700 |'),
    ('Cost Explorer 0,3500', REP, '| AWS Cost Explorer | 0,3500 |'),
    ('SQS 0,1434', REP, '| SQS | 0,1434 |'),
    ('8,7053 / ≈ **191,2947**', REP, 'Credit đã dùng (từ 2026-08-01): 8,7053 USD'),
    ('8,7053 / ≈ **191,2947**', REP, 'Credit còn lại: 191,2947 USD'),
    ('7,766 trên 150 USD; dự báo cả tháng 8,567', REP, 'ACTUAL tháng 11 = 7,766 USD, FORECASTED = 8,567 USD'),
    ('script dự báo 16,8232 USD', REP, '16,8232 USD'),
    ('6,15–7,30', CAP, '6,15–7,30'),
    ('| 0,1394 | 0,2752 |', CAP, '**0,1394** | **0,2752**'),
    ('**113,23** | **203,55**', CAP, '**113,23** | **203,55**'),
    ('0,3330 + WAF cố định 0,0110 = 0,3439', CAP, '**0,3330 USD/giờ**'),
    ('0,3330 + WAF cố định 0,0110 = 0,3439', CAP, '= 0,0110 USD/giờ'),
    ('| 0,45 | — | 1,03 |', CAP, '| Dev (làm việc, kiểm tay) | 0,45 | 0,60 | 0,75 |'),
    ('| 0,45 | — | 1,03 |', CAP, '| 1,03 | 1,38 | 1,72 |'),
    ('≈ 29 % ngày đo 21/11', CAP, '| 29 % |'),
    ('≈ 0,26 USD mỗi giờ 120 RPS', CAP, '**0,2592 USD**'),
    ('RDS Multi-AZ 39,99 + Valkey replica 14,02 + task `api` thứ hai 26,13', CAP, '| 0,0548 | 39,99 |'),
    ('RDS Multi-AZ 39,99 + Valkey replica 14,02 + task `api` thứ hai 26,13', CAP, '| 0,0192 | 14,02 |'),
    ('RDS Multi-AZ 39,99 + Valkey replica 14,02 + task `api` thứ hai 26,13', CAP, '| 0,0358 | 26,13 |'),
    ('**0,1098 USD/giờ, 80,14 USD/tháng**', CAP, '| **HA cộng** | **0,1098** | **80,14** |'),
    ('23–69 %', CAP, '**23,15 % nếu khôi phục xong trong 10 phút, 69,44 % nếu đúng mục tiêu 30 phút, 138,89 % nếu 60 phút**'),
    ('69,44 %', CAP, '69,44 %'),
    ('0,49–0,57 %', CAP, '**0,49–0,57 %**'),
    ('+0,25–0,42 USD cho 3–5 giờ ở cỡ micro', CAP, '**0,25 USD** | **0,42 USD**'),
    ('(66,12 USD/tháng)', CAP, 'tổng **66,12 USD/tháng**'),
]

bundle = open(BUNDLE, encoding='utf-8').read()
cache = {}


def read(path):
    if path not in cache:
        cache[path] = open(path, encoding='utf-8').read()
    return cache[path]


bad = 0


def report(ok, label):
    global bad
    print('PASS' if ok else 'FAIL', label)
    bad += 0 if ok else 1


for b_needle, path, s_needle in CHECKS:
    try:
        src = read(path)
    except OSError as e:
        report(False, f'không mở được {path}: {e}')
        continue
    in_bundle = b_needle in bundle
    in_source = s_needle in src
    report(in_bundle and in_source, f'bản ghép[{b_needle[:48]}]={in_bundle} | {path.split("/")[-1]}[{s_needle[:48]}]={in_source}')

# bảng SLO: từng dòng của bản ghép (§4) phải là một dòng nguyên văn của docs/03
sec = bundle.split('## 4. SLI/SLO chính thức')[1].split('## 5. Dashboard')[0]
d03 = read(D03)
rows = [ln for ln in sec.splitlines() if ln.startswith('| ') and not ln.startswith('| ---') and not ln.startswith('| SLI')]
for ln in rows:
    report(ln in d03, 'SLO nguyên văn: ' + ln[:60])
report(len(rows) == 9, f'bảng SLO có 9 dòng (có {len(rows)})')

# số ảnh dashboard
for mode in ('on', 'off'):
    d = f'docs/components/observability/screenshots/120rps-redis-{mode}'
    n = len([f for f in os.listdir(d) if f.endswith('.png')])
    report(n == 25 and f'120rps-redis-{mode}/' in bundle, f'{d}: {n} ảnh (bản ghép nói 25)')
report('mỗi lượt 25 ảnh' in bundle, 'bản ghép nêu «mỗi lượt 25 ảnh»')

print('KET LUAN:', 'mọi cặp khớp' if bad == 0 else f'{bad} chỗ lệch')
sys.exit(1 if bad else 0)
