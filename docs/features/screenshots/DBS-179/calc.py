"""DBS-179: mọi con số suy ra ở docs/components/platform-infra/02-capacity-cost.md (§4 đến §6).
Đầu vào là số đã in ở manual-test.txt (Cost Explorer ngày 21/11 theo USAGE_TYPE, báo cáo 2026-11-22 mục 2).
Chạy: PYTHONUTF8=1 python docs/features/screenshots/DBS-179/calc.py
"""
from decimal import Decimal as D, ROUND_HALF_UP


def q(x, n=4):
    return str(x.quantize(D(1).scaleb(-n), rounding=ROUND_HALF_UP)).replace('.', ',')


# Đơn giá quan sát (USD): chi phí ÷ quantity của chính usage type, ngày 21/11 và cả kỳ
P = dict(
    rds_micro=D('0.0250'), rds_small=D('0.0510'), rds_small_maz=D('0.1020'),
    stor=D('0.138'), stor_maz=D('0.276'),  # USD/GB-tháng
    node=D('0.0192'), alb=D('0.0252'),
    vcpu=D('0.0506'), gb=D('0.0055'),
    ipv4=D('0.005'),                       # 0,2649 / 52,971 địa chỉ-giờ
    ec2=D('0.0528'),                       # 0,5155 / 9,764 giờ `t3.medium`
    secret=D('0.40'), waf_acl=D('5'), waf_rule=D('1'),
    waf_req=D('0.60'),                     # 0,8493 / 1,415483 triệu request
)
H = D('730')
GB = D('20')
WAF_RULES = 3                              # modules/waf/main.tf: rate-limit + 2 managed rule group
RETAINED_DAY = D('0.0619')                 # KMS 0,033 + Secrets 0,027 (ngày 16/11-20/11)


def fargate(vcpu, gb):
    return vcpu * P['vcpu'] + gb * P['gb']


api1 = fargate(D('0.5'), D('1'))
wrk1 = fargate(D('0.25'), D('0.5'))
print('task api/giờ', q(api1), '· task worker/giờ', q(wrk1))


def hourly(rds, stor, nodes, api_n, wrk_n, albips=2):
    return {
        'RDS instance': rds,
        'RDS storage 20 GB': GB * stor / H,
        'Valkey': nodes * P['node'],
        'ALB': P['alb'],
        'Fargate api': api1 * api_n,
        'Fargate worker': wrk1 * wrk_n,
        'IPv4 công khai': (api_n + wrk_n + albips) * P['ipv4'],
    }


dev = hourly(P['rds_micro'], P['stor'], 1, 1, 1)
prod = hourly(P['rds_small_maz'], P['stor_maz'], 2, 2, 1)
dev_h, prod_h = sum(dev.values()), sum(prod.values())
loadgen_h = P['ec2'] + P['ipv4']
waf_fixed_month = P['waf_acl'] + WAF_RULES * P['waf_rule']
waf_fixed_h = waf_fixed_month / H
retained_month = RETAINED_DAY * D('30.4')
sec_dev, sec_prod = 2 * P['secret'], 3 * P['secret']  # secret của phiên: 2 (dev), 3 (prod, thêm redis_auth)
for name, c in (('dev', dev), ('production', prod)):
    print('==', name, 'USD/giờ', q(sum(c.values())), {k: q(v) for k, v in c.items()})
print('máy tải/giờ', q(loadgen_h), '· cấu hình đo (production + máy tải)/giờ', q(prod_h + loadgen_h))
print('WAF cố định/tháng', q(waf_fixed_month, 2), '· /giờ', q(waf_fixed_h), '· giữ lại/tháng', q(retained_month, 2))

# 24/7
dev_m = dev_h * H
prod_m = prod_h * H
dev_total = dev_m + waf_fixed_month + retained_month + sec_dev
dev_total_nowaf = dev_total - waf_fixed_month
prod_total = prod_m + retained_month + sec_prod  # production không có WAF
print('24/7 dev: tài nguyên', q(dev_m, 2), '· tổng', q(dev_total, 2), '· không WAF (sau 26/11)', q(dev_total_nowaf, 2))
print('24/7 production: tài nguyên', q(prod_m, 2), '· tổng', q(prod_total, 2))
for name, t in (('dev', dev_total), ('production', prod_total)):
    print(name, 'so với 150:', q(t / D(150) * 100, 0), '% · so với 200:', q(t / D(200) * 100, 0),
          '% · tháng tiêu hết credit 191,29:', q(D('191.2947') / t, 1))
print('12 RPS liên tục: request/tháng (triệu)', q(D(12) * 3600 * H / D(10**6), 1),
      '· phí', q(D(12) * 3600 * H / D(10**6) * P['waf_req'], 1))
print('ADR-11 24/7 cả 10 tuần = 70/30,4 tháng × dev', q(D(70) / D('30.4') * dev_total, 0))

# theo phiên: giờ × (giờ + WAF cố định) + phí theo tải
print('-- theo phiên (dev có WAF cố định; production + máy tải)')
for h in (3, 4, 5):
    h = D(h)
    print(h, 'giờ: dev', q(h * (dev_h + waf_fixed_h), 2), '· production+máy tải', q(h * (prod_h + loadgen_h + waf_fixed_h), 2))
print('dev 40 và 50 giờ/tuần', q(D(40) * (dev_h + waf_fixed_h), 2), q(D(50) * (dev_h + waf_fixed_h), 2))
waf_rps = lambda rps: D(rps) * 3600 / D(10**6) * P['waf_req']
print('WAF request 1 giờ: 120 RPS', q(waf_rps(120)), '· 12 RPS', q(waf_rps(12)))

# ngày UTC 21/11 (Cost Explorer, gộp, không kể Credit/Refund)
day = D('4.5917')
retained_day = D('0.0627')
sess = day - retained_day
load = dict(WAF_request=D('0.8493'), SQS_request=D('0.1434'), data_transfer_giua_AZ=D('0.0652') + D('0.0428') + D('0.0428'),
            CPU_credit_RDS=D('0.1202'), LCU_ALB=D('0.0536'))
load_sum = sum(load.values())
by_hour = sess - load_sum
print('-- ngày 21/11: phiên', q(sess), '· theo tải', q(load_sum), {k: q(v) for k, v in load.items()},
      '· theo giờ (phép trừ)', q(by_hour), '· tỉ lệ', q(load_sum / sess * 100, 0), '% /', q(by_hour / sess * 100, 0), '%')
print('theo tải không kể WAF request / 12 giờ ALB', q((load_sum - load['WAF_request']) / 12))
# kiểm mô hình độc lập (có thể trượt): 12 giờ ALB × giờ của cấu hình đo + phí tải thật
model_hour = D(12) * (prod_h + loadgen_h + waf_fixed_h)
model_total = model_hour + load_sum
print('mô hình: 12 giờ × (', q(prod_h + loadgen_h + waf_fixed_h), ') =', q(model_hour, 2), '+ phí tải', q(load_sum, 2), '=', q(model_total, 2),
      '· thật', q(sess, 2), '· mô hình cao hơn', q((model_total - sess) / sess * 100, 0), '%')
print('theo giờ thật / giờ ALB', q(by_hour / 12), '· mô hình / giờ', q(prod_h + loadgen_h + waf_fixed_h))

# dự báo tới 13/12 (phần chưa có trong Cost Explorer sau báo cáo)
print('-- dự báo 22/11 đến 13/12')
other_load_h = (load_sum - load['WAF_request']) / 12  # phí tải ngoài WAF request, mỗi giờ ALB ở ngày đo tải
cfg_h = prod_h + loadgen_h + waf_fixed_h
retained = RETAINED_DAY * 22
aws_a = D(2) * cfg_h  # phần UTC 22/11 của phiên AWS-A: 2 giờ ALB (00:00Z-01:37Z); giờ 23:00Z-24:00Z 21/11 đã nằm trong số 21/11
aws_a_lo, aws_a_hi = aws_a + D('0.3'), aws_a + D('0.6')
aws_b = D(5) * cfg_h + waf_rps(120) * D('1.5') + D(5) * other_load_h
spare_lo, spare_hi = D('1.5'), D('2.0')
print('giữ lại 22 ngày', q(retained, 2), '· AWS-A (22/11 UTC)', q(aws_a_lo, 2), '-', q(aws_a_hi, 2),
      '· AWS-B', q(aws_b, 2), '· dự phòng', q(spare_lo, 1), '-', q(spare_hi, 1))
lo = retained + aws_a_lo + aws_b + spare_lo
hi = retained + aws_a_hi + aws_b + spare_hi
print('cộng', q(lo, 2), '-', q(hi, 2), '· so với credit 191,2947:', q(hi / D('191.2947') * 100, 1), '%')
print('script: 0,7647 × 22 =', q(D('0.7647') * 22, 4), '· so với credit', q(D('16.8232') / D('191.2947') * 100, 1), '%')
print('budget tháng 11: 7,766 / 150 =', q(D('7.766') / 150 * 100, 1), '% · dự báo cả tháng 8,567 → phần còn lại 22-30/11', q(D('8.567') - D('7.766'), 3))
print('21/11 so với tổng kỳ', q(day / D('8.2642') * 100, 1), '%')
