"""Dựng ảnh từ số đo thật (k6 per-minute.json, CloudWatch export). Dùng: python charts.py <results_dir> <out_dir> <after_baseline_dir> <after_hot_dir> [<after_stress_dir>]"""
import json, sys, os
from datetime import datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

res, out = sys.argv[1], sys.argv[2]
after_base, after_hot = sys.argv[3], sys.argv[4]
os.makedirs(out, exist_ok=True)
R = lambda *p: os.path.join(res, *p)


def per_minute(d, scenario):
    rows = [r for r in json.load(open(R(d, 'per-minute.json'), encoding='utf8')) if r['scenario'] == scenario]
    return [(r['minute'], r['p95'], r['count'], r['systemErrors']) for r in rows]


def cw(d):
    j = json.load(open(R(d, 'cloudwatch.json'), encoding='utf8'))
    return j['series']


def series(s, key):
    return [(datetime.fromisoformat(t.replace('Z', '+00:00')), v) for t, v in s[key]['points']]


# 1. p95 chuyển tiền theo phút, plateau 120 của baseline: hai lượt trước, một lượt sau
fig, ax = plt.subplots(figsize=(10, 4.2))
for d, label, style in (
    ('baseline-efb059bd', 'trước, lượt 1 (DBS-166)', 'o--'),
    ('s1-before-baseline', 'trước, lượt 2 (S1)', 's--'),
    (after_base, 'sau (S2, image DBS-173)', 'o-'),
):
    pm = [x for x in per_minute(d, 'write_120') if x[2] >= 500]
    ax.plot([x[0] - pm[0][0] for x in pm], [x[1] for x in pm], style, label=label)
ax.axhline(300, color='red', lw=1, ls=':')
ax.text(0, 310, 'ngưỡng 300 ms', color='red', fontsize=8)
ax.set_yscale('log')
ax.set_xlabel('phút của plateau 120 RPS')
ax.set_ylabel('p95 POST /v1/transfers (ms, log)')
ax.set_title('baseline: p95 chuyển tiền theo phút ở 120 RPS')
ax.legend(fontsize=8)
ax.grid(alpha=0.3)
fig.tight_layout()
fig.savefig(os.path.join(out, '01-p95-chuyen-tien-theo-phut-120rps.png'), dpi=130)

# 2. hot-account: p95 theo phút, trước và sau
fig, ax = plt.subplots(figsize=(10, 4.2))
for d, label, style in (
    ('s1-before-hot-account', 'trước (tài khoản nóng ≈ 11.500 → 29.500 dòng)', 'o--'),
    ('s2-hot-account-1', 'sau, lượt 1 (≈ 11.500 → 29.700 dòng)', 'o-'),
    ('s2-hot-account-2', 'sau, lượt 2 (≈ 37.800 → 55.000 dòng)', 's-'),
):
    pm = [x for x in per_minute(d, 'hot') if x[2] >= 800]
    ax.plot([x[0] - pm[0][0] for x in pm], [x[1] for x in pm], style, label=label)
ax.axhline(1000, color='red', lw=1, ls=':')
ax.text(0, 1030, 'ngưỡng NFR-SCAL-02: 1 s', color='red', fontsize=8)
ax.set_xlabel('phút của bài hot-account (20 lệnh/giây)')
ax.set_ylabel('p95 POST /v1/transfers (ms)')
ax.set_title('hot-account, worker bật: p95 theo phút')
ax.legend(fontsize=8)
ax.grid(alpha=0.3)
fig.tight_layout()
fig.savefig(os.path.join(out, '02-hot-account-p95-theo-phut.png'), dpi=130)

# 3. CPU RDS và worker, trước/sau (hot-account S1, cùng cấu hình)
fig, axes = plt.subplots(1, 2, figsize=(11, 4))
for d, label, style in (('s1-before-hot-account', 'trước', '--'), ('s2-hot-account-1', 'sau (lượt 1)', '-')):
    s = cw(d)
    for ax, key, title in ((axes[0], 'rds_cpu_avg', 'CPU RDS (% trung bình mỗi phút)'), (axes[1], 'worker_cpu_avg', 'CPU worker (%)')):
        pts = series(s, key)
        ax.plot([(t - pts[0][0]).total_seconds() / 60 for t, _ in pts], [v for _, v in pts], style, label=label)
        ax.set_title(title)
        ax.set_xlabel('phút từ đầu cửa sổ')
        ax.grid(alpha=0.3)
axes[0].legend()
fig.suptitle('hot-account (worker bật): tải CPU trước và sau')
fig.tight_layout()
fig.savefig(os.path.join(out, '03-hot-account-cpu-rds-worker.png'), dpi=130)
print('ok')
