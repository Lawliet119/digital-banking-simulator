#!/usr/bin/env python3
"""DBS-143: báo cáo chi phí AWS từ Cost Explorer theo dịch vụ, giờ dựng, tag env, credit và dự báo.

Chỉ đọc. Gọi AWS CLI v2 (`aws ce …`), credential theo AWS_PROFILE của người chạy; mỗi lệnh Cost Explorer
tính 0,01 USD (một lần chạy 4–6 lệnh). In báo cáo Markdown ra stdout; lỗi bất kỳ thì stdout rỗng.
Ngày theo UTC; --end và --project-end không tính (exclusive). Quy trình thứ Hai: infra/terraform/README.md.

Dùng:  AWS_PROFILE=dbs-admin python3 infra/scripts/cost-report.py [--start 2026-10-01] [--end <hôm nay UTC>]
         [--credit-total 200] [--credit-since 2026-08-01] [--project-end 2026-12-14] > <báo cáo>.md
  COST_REPORT_TODAY=YYYY-MM-DD  thay "hôm nay UTC" (chỉ cho test)
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from decimal import Decimal, InvalidOperation

NOT_CREDIT = {"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}}
USAGE_ONLY = {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}}

# Thứ tự và tên dòng theo DoD 1 của DBS-143; mỗi SERVICE chỉ thuộc một dòng nên tổng không bị cộng hai lần.
DOD_SERVICES = [
    ("RDS", "Amazon Relational Database Service"),
    ("ElastiCache", "Amazon ElastiCache"),
    ("ECS", "Amazon Elastic Container Service"),
    ("ALB", "Amazon Elastic Load Balancing"),
    ("SQS", "Amazon Simple Queue Service"),
    ("CloudWatch", "AmazonCloudWatch"),
    ("Data transfer", "AWS Data Transfer"),
]
TRANSFER = re.compile(r"DataTransfer|-(In|Out)-Bytes")
HOUR_GROUPS = [
    ("RDS instance", re.compile(r"(InstanceUsage|Multi-AZUsage):db\."), "giờ"),
    ("RDS storage", re.compile(r"RDS:.*Storage"), "GB-tháng"),
    ("ElastiCache node", re.compile(r"NodeUsage:cache\."), "giờ"),
    ("ALB", re.compile(r"LoadBalancerUsage"), "giờ"),
    ("Fargate", re.compile(r"Fargate-(vCPU|GB)-Hours"), "vCPU-giờ / GB-giờ"),
    ("Secrets Manager", re.compile(r"AWSSecretsManager-Secret$"), "secret-tháng"),
]
SESSION = re.compile(r"(InstanceUsage|Multi-AZUsage):db\.|NodeUsage:cache\.|LoadBalancerUsage|Fargate-vCPU-Hours")
FORBIDDEN = re.compile(r"NatGateway|VpcEndpoint")  # ADR-10
ZERO = Decimal(0)


class AwsError(Exception):
    pass


def usd(d):
    return f"{d:.4f}".replace(".", ",")


def qty(d):
    return f"{d:.3f}".replace(".", ",")


def ddmm(day):
    return day.strftime("%d/%m")


def aws(*args):
    p = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if p.returncode != 0:
        raise AwsError(f"aws {args[0]} {args[1]}: {p.stderr.strip()}")
    return json.loads(p.stdout)


def period(start, end):
    return f"Start={start.isoformat()},End={end.isoformat()}"


def paged(*args):
    """get-cost-and-usage tới hết trang; gộp nhóm theo ngày bắt đầu của TimePeriod."""
    by_start = defaultdict(list)
    token = None
    while True:
        out = aws(*args, *(["--next-page-token", token] if token else []))
        for r in out["ResultsByTime"]:
            by_start[r["TimePeriod"]["Start"]].extend(r.get("Groups", []))
        token = out.get("NextPageToken")
        if not token:
            return by_start


def amount(group, metric="UnblendedCost"):
    return Decimal(group["Metrics"][metric]["Amount"])


def parse_args(argv, today):
    def day(s):
        try:
            return dt.date.fromisoformat(s)
        except ValueError:
            raise argparse.ArgumentTypeError(f"ngày sai định dạng YYYY-MM-DD: {s}")

    def money(s):
        try:
            return Decimal(s)
        except InvalidOperation:
            raise argparse.ArgumentTypeError(f"không phải số: {s}")

    ap = argparse.ArgumentParser(description="Báo cáo chi phí AWS từ Cost Explorer (DBS-143).")
    ap.add_argument("--start", type=day, default=dt.date(2026, 10, 1))
    ap.add_argument("--end", type=day, default=today)
    ap.add_argument("--credit-total", type=money, default=Decimal(200))
    ap.add_argument("--credit-since", type=day, default=dt.date(2026, 8, 1))
    ap.add_argument("--project-end", type=day, default=dt.date(2026, 12, 14))
    a = ap.parse_args(argv)
    if a.end <= a.start:
        ap.error("--end phải sau --start")
    if a.end > today + dt.timedelta(days=1):
        ap.error("--end không được quá hôm nay UTC + 1")
    if a.credit_total < 0:
        ap.error("--credit-total không được âm")
    if a.credit_since > a.start:
        ap.error("--credit-since không được sau --start")
    if a.project_end < a.end:
        ap.error("--project-end không được trước --end")
    return a


def first_of_next_month(d):
    return dt.date(d.year + d.month // 12, d.month % 12 + 1, 1)


def collect(a, today):
    data = {}
    data["usage"] = paged("ce", "get-cost-and-usage", "--time-period", period(a.start, a.end),
                          "--granularity", "DAILY", "--metrics", "UnblendedCost", "UsageQuantity",
                          "--group-by", "Type=DIMENSION,Key=SERVICE", "Type=DIMENSION,Key=USAGE_TYPE",  # một cờ: CLI chỉ giữ lần cuối
                          "--filter", json.dumps(NOT_CREDIT))
    tags = aws("ce", "list-cost-allocation-tags", "--tag-keys", "project", "env", "owner")
    data["tags"] = {t["TagKey"]: t["Status"] for t in tags.get("CostAllocationTags", [])}
    if data["tags"].get("env") == "Active":
        data["env"] = paged("ce", "get-cost-and-usage", "--time-period", period(a.start, a.end),
                            "--granularity", "MONTHLY", "--metrics", "UnblendedCost",
                            "--group-by", "Type=TAG,Key=env", "--filter", json.dumps(NOT_CREDIT))
        reqs = aws("ce", "list-cost-allocation-tag-backfill-history").get("BackfillRequests", [])
        data["backfill"] = max(reqs, key=lambda r: r["RequestedAt"])["BackfillStatus"] if reqs else None
    data["credits"] = paged("ce", "get-cost-and-usage", "--time-period", period(a.credit_since, a.end),
                            "--granularity", "MONTHLY", "--metrics", "UnblendedCost",
                            "--group-by", "Type=DIMENSION,Key=RECORD_TYPE")
    data["forecast"] = None
    if a.end >= today:
        try:
            fc = aws("ce", "get-cost-forecast", "--time-period", period(a.end, first_of_next_month(a.end)),
                     "--metric", "UNBLENDED_COST", "--granularity", "MONTHLY", "--filter", json.dumps(USAGE_ONLY))
            data["forecast"] = Decimal(fc["Total"]["Amount"])
        except AwsError as e:
            if "DataUnavailableException" not in str(e):
                raise
            data["forecast"] = "unavailable"
    else:
        data["forecast"] = "past"
    return data


def render(a, data):
    last = a.end - dt.timedelta(days=1)
    week_start = a.end - dt.timedelta(days=7)
    svc_total, svc_week = defaultdict(lambda: ZERO), defaultdict(lambda: ZERO)
    ut = defaultdict(lambda: [ZERO, ZERO])  # usage type → [chi phí, quantity]
    transfer_elsewhere = ZERO
    session_days, forbidden, last_day_session = set(), set(), set()
    for start, groups in data["usage"].items():
        day = dt.date.fromisoformat(start)
        for g in groups:
            svc, utype = g["Keys"] if len(g["Keys"]) == 2 else ("(không rõ dịch vụ)", g["Keys"][-1])
            cost, q = amount(g), amount(g, "UsageQuantity")
            svc_total[svc] += cost
            if day >= week_start:
                svc_week[svc] += cost
            ut[utype][0] += cost
            ut[utype][1] += q
            if TRANSFER.search(utype) and svc != "AWS Data Transfer":
                transfer_elsewhere += cost
            if SESSION.search(utype) and (q > 0 or cost > 0):
                session_days.add(day)
                if day == last:
                    last_day_session.add(utype)
            if day == last and "WAF" in svc and cost > 0:
                last_day_session.add(svc)
            if FORBIDDEN.search(utype) and (q > 0 or cost > 0):
                forbidden.add(utype)

    total, total_week = sum(svc_total.values(), ZERO), sum(svc_week.values(), ZERO)
    out = [f"# Báo cáo chi phí AWS {a.start.isoformat()} → {a.end.isoformat()}", "",
           f"Chi phí gộp (trước credit), USD, ngày UTC; khoảng [{a.start.isoformat()}, {a.end.isoformat()}). "
           f"Ngày cuối ({ddmm(last)}) có thể chưa đủ: Cost Explorer trễ tới 24 giờ.", "",
           "## 1. Theo dịch vụ", "",
           f"| Dịch vụ | Lũy kế | 7 ngày cuối ({ddmm(week_start)}–{ddmm(last)}) |", "|---|---:|---:|"]
    dod_names = {s for _, s in DOD_SERVICES}
    for label, svc in DOD_SERVICES:
        out.append(f"| {label} | {usd(svc_total[svc])} | {usd(svc_week[svc])} |")
    for svc in sorted((s for s in svc_total if s not in dod_names and svc_total[s] != 0), key=lambda s: (-svc_total[s], s)):
        out.append(f"| {svc} | {usd(svc_total[svc])} | {usd(svc_week[svc])} |")
    out += [f"| **Tổng** | **{usd(total)}** | **{usd(total_week)}** |", "",
            f"- Phụ: trong đó data transfer tính ở dịch vụ khác: {usd(transfer_elsewhere)} (đã nằm trong dịch vụ gốc, không cộng thêm).", ""]

    out += ["## 2. Số giờ dựng và đơn giá", "",
            "| Nhóm | Usage type | Quantity | Chi phí | Đơn giá |", "|---|---|---:|---:|---:|"]
    for label, rx, unit in HOUR_GROUPS:
        for utype in sorted(u for u in ut if rx.search(u)):
            cost, q = ut[utype]
            price = usd(cost / q) if q > 0 else "—"
            out.append(f"| {label} | `{utype}` | {qty(q)} {unit} | {usd(cost)} | {price} |")
    days = sorted(session_days)
    out += ["", f"- Ngày có phiên: {len(days)} ngày ({', '.join(ddmm(d) for d in days) or 'không có'}).", ""]

    out += ["## 3. Theo tag env", ""]
    tag_note = None
    if data["tags"].get("env") != "Active":
        out.append("Tag `env` chưa bật trong Cost allocation tags (trạng thái: "
                   f"{data['tags'].get('env', 'không thấy')}); xem infra/terraform/README.md mục Báo cáo chi phí tuần.")
    else:
        env = defaultdict(lambda: ZERO)
        for groups in data["env"].values():
            for g in groups:
                key = g["Keys"][0].split("$", 1)[1] if "$" in g["Keys"][0] else g["Keys"][0]
                env[key or "(không tag)"] += amount(g)
        env_total = sum(env.values(), ZERO)
        out += ["| env | Lũy kế |", "|---|---:|"]
        for k in sorted(env, key=lambda k: (k == "(không tag)", k)):
            out.append(f"| {k} | {usd(env[k])} |")
        untagged = env.get("(không tag)", ZERO)
        if (env_total > 0 and untagged * 10 >= env_total * 9) or data["backfill"] not in (None, "SUCCEEDED"):
            tag_note = "dữ liệu tag chưa đủ (chờ backfill hoặc 24 giờ sau khi bật tag)"
            out += ["", f"- Lưu ý: {tag_note}; backfill gần nhất: {data['backfill'] or 'không có'}."]
    out.append("")

    used = -sum((amount(g) for groups in data["credits"].values() for g in groups if g["Keys"][0] == "Credit"), ZERO)
    remaining = a.credit_total - used
    rate = total_week / 7
    days_left = (a.project_end - a.end).days
    projection = rate * days_left
    fc = data["forecast"]
    fc_text = {"unavailable": "không có (Cost Explorer chưa đủ dữ liệu)",
               "past": "bỏ qua (khoảng trong quá khứ)"}.get(fc) if isinstance(fc, str) else f"{usd(fc)} USD"
    warnings = []
    if projection > remaining:
        warnings.append(f"CẢNH BÁO: dự báo tới cuối dự án {usd(projection)} USD vượt credit còn lại {usd(remaining)} USD.")
    if forbidden:
        warnings.append(f"CẢNH BÁO ADR-10: có usage cấm ({', '.join(sorted(forbidden))}).")
    if last_day_session:
        warnings.append(f"Nhắc: ngày {ddmm(last)} còn chi phí tài nguyên phiên ({', '.join(sorted(last_day_session))}), "
                        "tài nguyên phiên có thể chưa xóa; chạy quy trình Down.")
    out += ["## 4. Credit và dự báo", "",
            f"- Credit đã dùng (từ {a.credit_since.isoformat()}): {usd(used)} USD (ước tính, đối chiếu console Billing → Credits).",
            f"- Credit còn lại: {usd(remaining)} USD (credit tổng {usd(a.credit_total)}).",
            f"- Dự báo AWS [{a.end.isoformat()}, hết tháng): {fc_text}.",
            f"- Dự báo tới cuối dự án [{a.end.isoformat()}, {a.project_end.isoformat()}): {usd(projection)} USD "
            f"(trung bình 7 ngày cuối {usd(rate)} USD/ngày × {days_left} ngày; không cộng với dự báo AWS).", ""]

    out += ["## 5. Cảnh báo", ""]
    out += [f"- {w}" for w in warnings] or ["- Không có."]
    out.append("")

    biggest = max(svc_week, key=lambda s: svc_week[s], default=None)
    out += ["## 6. Đề xuất cắt giảm", ""]
    if biggest:
        out.append(f"- Khoản lớn nhất 7 ngày cuối: {biggest} ({usd(svc_week[biggest])} USD).")
    out += [f"- {w}" for w in warnings]
    out += ["- (Người chạy bổ sung trước khi gửi.)", ""]

    out += ["## 7. Tóm tắt gửi nhóm", "", "```",
            f"Chi phí AWS 7 ngày ({ddmm(week_start)}–{ddmm(last)}): {usd(total_week)} USD; lũy kế từ {ddmm(a.start)}: {usd(total)} USD.",
            f"Credit còn lại ≈ {usd(remaining)} / {usd(a.credit_total)} USD; dự báo tới {ddmm(a.project_end - dt.timedelta(days=1))}: {usd(projection)} USD.",
            f"Giờ dựng: {len(days)} ngày có phiên." + (f" {tag_note}." if tag_note else ""),
            ("Cảnh báo: " + " ".join(warnings)) if warnings else "Không có cảnh báo.", "```"]
    return "\n".join(out) + "\n"


def main(argv=None):
    today = dt.date.fromisoformat(os.environ["COST_REPORT_TODAY"]) if os.environ.get("COST_REPORT_TODAY") \
        else dt.datetime.now(dt.timezone.utc).date()
    a = parse_args(sys.argv[1:] if argv is None else argv, today)
    try:
        data = collect(a, today)
    except AwsError as e:
        print(f"Lỗi khi gọi {e}", file=sys.stderr)
        return 1
    sys.stdout.write(render(a, data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
