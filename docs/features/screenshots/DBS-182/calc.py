"""DBS-182: so sánh chi phí dev Single-AZ và production Multi-AZ, tách từng yếu tố HA.
Đơn giá: báo cáo chi phí 2026-11-22 mục 2 (Cost Explorer, ap-southeast-1); công thức cùng 02-capacity-cost.md §4.
Chạy: PYTHONUTF8=1 python docs/features/screenshots/DBS-182/calc.py
"""
from decimal import Decimal as D, ROUND_HALF_UP


def q(x, n=4):
    return str(x.quantize(D(1).scaleb(-n), rounding=ROUND_HALF_UP)).replace('.', ',')


H = D('730')
GB = D('20')
rds_micro, rds_small, rds_small_maz = D('0.0250'), D('0.0510'), D('0.1020')
stor, stor_maz = D('0.138'), D('0.276')
node, ipv4 = D('0.0192'), D('0.005')
api_task = D('0.5') * D('0.0506') + D('1') * D('0.0055')

# từng yếu tố khác nhau giữa dev và production, USD/giờ
rows = [
    ('RDS Multi-AZ (instance gấp đôi + storage gấp đôi), cùng lớp `db.t4g.small`',
     (rds_small_maz - rds_small) + GB * (stor_maz - stor) / H, 'HA'),
    ('Valkey replica (node thứ hai)', node, 'HA'),
    ('Task `api` thứ hai (Fargate 0,5 vCPU / 1 GB + 1 IPv4)', api_task + ipv4, 'HA'),
    ('RDS `db.t4g.micro` → `db.t4g.small` (cùng Single-AZ, cho tải 120 RPS)', rds_small - rds_micro, 'dung lượng'),
]
ha = sum(v for _, v, k in rows if k == 'HA')
cap = sum(v for _, v, k in rows if k == 'dung lượng')
print('| Yếu tố | USD/giờ | USD/tháng 24/7 | Loại |')
for n, v, k in rows:
    print('|', n, '|', q(v), '|', q(v * H, 2), '|', k, '|')
print('HA cộng', q(ha), q(ha * H, 2))
print('dung lượng cộng', q(cap), q(cap * H, 2))
print('tổng chênh', q(ha + cap), q((ha + cap) * H, 2))
dev, prod = D('0.1394'), D('0.2752')
print('kiểm: prod - dev =', q(prod - dev), '=', q(ha + cap))
print('HA 24/7 so với dev 24/7 chỉ tài nguyên (101,75):', q(ha * H / D('101.75') * 100, 1), '%; credit 191,2947 dùng hết sau', q(D('191.2947') / (ha * H), 1), 'tháng nếu chỉ trả phần HA')
print('production 24/7 (203,55) bỏ phần HA =', q(D('203.55') - ha * H, 2), '(so với Budget 150)')
# ngân sách lỗi 99,9% / 30 ngày
budget = D('43200') * D('0.001') * D('60')  # giây
print('ngân sách lỗi 30 ngày (giây)', budget, '=', q(budget / 60, 1), 'phút')
for name, sec in (('RTO giả định 10 phút', D('600')), ('RTO giả định 60 phút', D('3600')), ('khoảng 503 trên probe 12,7 s (failover chưa xác nhận)', D('12.7')), ('khoảng 503 trên probe 14,7 s (failover chưa xác nhận)', D('14.7')), ('task api dừng, tối đa 137 s (dev 1 task)', D('137')), ('RTO thiết kế 30 phút', D('1800')), ('hai sự cố RTO thiết kế', D('3600'))):
    print(name, q(sec / budget * 100, 2), '% ngân sách lỗi tháng')
# phiên demo
for h in (3, 5):
    print('phiên', h, 'giờ: thêm HA', q(ha * h, 2), 'USD; thêm HA + dung lượng', q((ha + cap) * h, 2))

# tổng hai cấu hình (nguồn: calc.py của DBS-179, §4-§5 của 02-capacity-cost.md)
print('dev/giờ 0,1394 · production/giờ 0,2752 · chênh', q(D('0.2752') - D('0.1394')))
print('24/7 chỉ tài nguyên: dev 101,75 · production 200,87 · chênh', q(D('200.87') - D('101.75'), 2))

# phiên diễn tập ở dev cỡ micro: db_multi_az + redis_replicas=1 + desired_count=2
ha_micro = (D('0.0510') - D('0.0250')) + GB * (stor_maz - stor) / H + node + (api_task + ipv4)
print('dev micro: Multi-AZ micro', q((D('0.0510') - D('0.0250')) + GB * (stor_maz - stor) / H), '· HA đủ ba biến', q(ha_micro),
      '· 3 giờ', q(ha_micro * 3, 2), '· 5 giờ', q(ha_micro * 5, 2), '· Multi-AZ micro một ngày', q(((D('0.0510') - D('0.0250')) + GB * (stor_maz - stor) / H) * 24, 2))
