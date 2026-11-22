"""DBS-189: mỗi con số trong docs/deliverables/P4-production-engineering.md phải xuất hiện nguyên văn trong tài liệu gốc.
Chạy ở thư mục gốc repo: PYTHONUTF8=1 python docs/features/screenshots/DBS-189/verify-numbers.py
Thoát 0 khi mọi số khớp; thoát 1 và in dòng FAIL nếu một số vắng ở nguồn hoặc ở bản ghép.
"""
import os
import sys

BUNDLE = os.environ.get('P4_BUNDLE', 'docs/deliverables/P4-production-engineering.md')  # đổi để thử ca trượt (M-189-02)
L = 'docs/components/load-tests/'
R02, R03, R04, R05 = (L + '02-ket-qua-tai-cloud-2026-11-21.md', L + '03-ket-qua-toi-uu-p95-2026-11-21.md',
                      L + '04-ket-qua-bl-418-2026-11-22.md', L + '05-ket-qua-redis-2026-11-22.md')
INC = 'docs/deliverables/P4-incident-table.md'
CAP = 'docs/components/platform-infra/02-capacity-cost.md'
REP = 'docs/components/platform-infra/cost-reports/2026-11-22.md'
D03 = 'docs/03_HIGH_LEVEL_ARCHITECTURE.md'
BL = 'docs/BACKLOG.md'

# (số trong bản ghép, tệp nguồn, chuỗi trong nguồn)
CHECKS = [
    ('p95 12/60/120 = 42 / 60 / 218', R02, 'chuyển p95 42 / 60 / 218 ms, p99 106 / 153 / 703 ms'),
    ('đọc p95 ≤ 61 ms', R02, 'đọc p95 ≤ 61 ms'),
    ('hot-account 299 timeout 1,66%', R02, '299 timeout 2 giây (1,66% > 0,1%)'),
    ('hot-account p95 824', R02, 'p95 824 ms'),
    ('218,2 / 703,2', R03, '36,7 / 218,2 / 703,2'),
    ('262,4 / 850,9', R03, '31,9 / **262,4** / **850,9**'),
    ('5/16 khung, đỉnh 678', R03, '**5 / 16 (đỉnh 678)**'),
    ('3/15 khung, đỉnh 641', R03, '3 / 15 (đỉnh 641)'),
    ('stress 304,1 / 996,8', R03, '**304,1 / 996,8**'),
    ('stress trước 784, 43 lỗi 0,119%', R03, '43 / 0,119% / 0'),
    ('hot-account lượt 1 p95 121, 4 timeout', R03, '**4 (0,022%)**'),
    ('hot-account lượt 2 1.881 timeout 10,4%', R03, '**1.881 (10,4%)**'),
    ('duplicate 600 × 201, 60 × 422, p95 81', R03, '600 × 201 cùng thân và 60 × 422'),
    ('BL-418 p95 91,9', R04, 'p95 **91,9 ms**'),
    ('BL-418 p99 585,5', R04, 'p99 585,5 ms'),
    ('BL-418 9 timeout 0,0083%', R04, '9 lỗi timeout (0,0083%)'),
    ('BL-418 2 khung vượt 442 và 377', R04, '(442 và 377 ms)'),
    ('BL-418 chờ khóa 22,4 → 9,8', R04, '22,4 → **9,8 ms**'),
    ('BL-418 stress 119,9; 7 lỗi 0,019%', R04, '7 lỗi (0,019%)'),
    ('BL-418 plateau 180 0,13% (71)', R04, '0,13% lỗi (71)'),
    ('BL-418 plateau 240 68,9%', R04, '68,9%'),
    ('Redis tắt p95 119 ms', R05, 'p95 chuyển tiền 119 ms'),
    ('Redis chậm 203 và 289', R05, 'p95 chuyển tiền 203 và 289 ms'),
    ('Redis chậm đọc 138 và 149', R05, 'p95 đọc 138 và 149 ms'),
    ('Redis chậm history 142 và 154', R05, '142 và **154 ms (vượt 4 ms)**'),
    ('Redis breaker mở 10 giây', R05, 'Breaker mở trong 10 giây đầu'),
    ('hồi phục 42,5 giây (BL-424)', BL, '**42,5 giây**'),
    ('DBS-185 131 s / 137 s', INC, 'RUNNING sau **131 s**, service ổn định sau **137 s**'),
    ('DBS-185 ECS gỡ target 25 s, 502', INC, 'ECS gỡ target sau 25 s'),
    ('DBS-184 worker alarm 9 phút 5 giây', INC, '**9 phút 5 giây**'),
    ('DBS-184 worker cờ 43 s; alarm OK 4 phút 39 giây', INC, 'cờ 65 MEDIUM sau **43 s**'),
    ('DBS-184 (b) 2 s và 190 s', INC, 'sau **2 s**; alarm `dbs-dev-risk-dlq-not-empty` `ALARM` sau **190 s**'),
    ('DBS-156 40 s, 197 s', INC, 'Sau 40 s `/health/ready` 503; sau 197 s'),
    ('DBS-156 127 s, 267 s', INC, '`/health/ready` 200 sau 127 s, tổng 267 s'),
    ('DBS-186 312 ms', INC, '(312 ms, đường SQL fallback)'),
    ('DBS-186 recovery 84,3 s', INC, 'sau **84,3 s**'),
    ('DBS-181 14,7 s', 'docs/features/screenshots/DBS-181/manual-test.txt', 'Outage window (first 503 -> last 503): 14.7s'),
    ('DBS-181 12,7 s', 'docs/features/screenshots/DBS-181/manual-test.txt', 'Outage window (first 503 -> last 503): 12.7s'),
    ('SLO ≥ 99,9%, 43 phút', D03, '≥ 99,9% | 30 ngày (ngân sách lỗi ≈ 43 phút)'),
    ('SLO p95 < 300, p99 < 1 s', D03, 'p95 < 300 ms, p99 < 1 s ở ≤ 120 RPS'),
    ('SLO đọc < 150', D03, '| < 150 ms | 5 phút'),
    ('SLO cờ < 5 giây', D03, '| < 5 giây | 15 phút'),
    ('SLO outbox < 10 giây', D03, '| < 10 giây | 1 phút'),
    ('SLO cờ/1.000 ≤ 20', D03, '| ≤ 20 | 24 giờ trượt'),
    ('dashboard 33 widget', 'docs/features/DBS-178-dashboard-complete.md', '33 widget: 7 `text`, 1 `alarm`, 25 `metric`'),
    ('chi phí 8,2642', REP, '**8,2642**'),
    ('credit còn 191,2947', REP, '191,2947'),
    ('dự báo 16,8232', REP, '16,8232'),
    ('24/7 dev 113,23', CAP, '**113,23**'),
    ('24/7 production 203,55', CAP, '**203,55**'),
    ('HA 80,14', CAP, '**80,14**'),
    ('giờ dev 0,1394 / production 0,2752', CAP, '**0,1394**'),
    ('dự báo 6,15–7,30', CAP, '6,15–7,30'),
    ('phiên 3 giờ production 1,03', CAP, '| 1,03 |'),
]

# các số phải có trong bản ghép (để kiểm cả chiều ngược lại)
IN_BUNDLE = ['42 / 60', '218,2 / 703,2', '262,4 / 850,9', '91,9 / 585,5', '0,0083 %', '2/15 khung', '9,8 ms', '119,9 ms',
             '1.881 timeout (10,4 %)', '203 và 289', '154 ms', '42,5 giây', '131 s', '137 s', '9 phút 5 giây', '84,3 s',
             '14,7 s và 12,7 s', '≥ 99,9 %', '33 widget', '8,2642 USD', '191,2947', '16,8232', '113,23', '203,55', '80,14',
             '6,15–7,30', '0,1394', '0,2752']

bundle = open(BUNDLE, encoding='utf-8').read()
bad = 0
for label, path, needle in CHECKS:
    try:
        text = open(path, encoding='utf-8').read()
    except OSError as e:
        print('FAIL', label, 'không mở được', path, e)
        bad += 1
        continue
    ok = needle in text
    print('PASS' if ok else 'FAIL', label, '|', path.split('/')[-1], '|', needle[:60])
    bad += 0 if ok else 1
for needle in IN_BUNDLE:
    ok = needle in bundle
    print('PASS' if ok else 'FAIL', 'bản ghép có', needle)
    bad += 0 if ok else 1
print('KET LUAN:', 'mọi số khớp nguồn' if bad == 0 else f'{bad} chỗ lệch')
sys.exit(1 if bad else 0)
