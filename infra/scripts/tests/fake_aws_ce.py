#!/usr/bin/env python3
"""`aws` giả cho test của cost-report.py (DBS-143): chỉ hiểu các lệnh `aws ce …` mà script gọi.

Dữ liệu lấy từ $FAKE_STATE/fixture.json:
  usage:     {"YYYY-MM-DD": [[service, usage_type, cost, quantity], ...]}  (lệnh #1, DAILY SERVICE + USAGE_TYPE;
             service null → nhóm chỉ có một khóa, như Cost Explorer thật trả cho vài dòng không gắn dịch vụ)
  page_size: số nhóm tối đa mỗi trang của lệnh #1 (mặc định không chia trang)
  tags:      {"env": "Active", ...}                                        (list-cost-allocation-tags)
  env:       {"env$dev": "0.60", "env$": "0.05"}                            (nhóm TAG env, một tháng)
  backfill:  "SUCCEEDED" | "PROCESSING" | null                              (list-cost-allocation-tag-backfill-history)
  credits:   {"YYYY-MM-01": "-0.05"}                                        (nhóm RECORD_TYPE, MONTHLY)
  forecast:  "1.23" | {"error": "DataUnavailableException"}
  fail:      {"<lệnh>": "AccessDeniedException"}                           (lệnh đó lỗi, thoát 254)

Ghi mỗi lời gọi (argv) vào $FAKE_STATE/calls.jsonl.
"""
import json
import os
import sys

STATE_DIR = os.environ["FAKE_STATE"]


def arg(argv, name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


def fail(op, code):
    sys.stderr.write(f"\nAn error occurred ({code}) when calling the {op} operation: fake error\n")
    sys.exit(254)


def period(argv):
    p = dict(kv.split("=", 1) for kv in arg(argv, "--time-period").split(","))
    return p["Start"], p["End"]


def group_keys(argv):
    """Như AWS CLI thật: `--group-by` lặp lại thì chỉ lần cuối có hiệu lực; nhiều nhóm phải nằm sau một cờ."""
    if "--group-by" not in argv:
        return []
    i = len(argv) - 1 - argv[::-1].index("--group-by")
    out = []
    for a in argv[i + 1:]:
        if a.startswith("--"):
            break
        out.append(a)
    return out


def metrics(cost, qty=None):
    m = {"UnblendedCost": {"Amount": str(cost), "Unit": "USD"}}
    if qty is not None:
        m["UsageQuantity"] = {"Amount": str(qty), "Unit": "N/A"}
    return m


def usage(fx, argv):
    start, end = period(argv)
    both = group_keys(argv) == ["Type=DIMENSION,Key=SERVICE", "Type=DIMENSION,Key=USAGE_TYPE"]
    rows = []  # (day, group) theo thứ tự ngày
    for day in sorted(fx.get("usage", {})):
        if start <= day < end:
            for svc, ut, cost, qty in fx["usage"][day]:
                rows.append((day, {"Keys": [svc, ut] if svc and both else [ut], "Metrics": metrics(cost, qty)}))
    size = fx.get("page_size") or len(rows) or 1
    page = int(arg(argv, "--next-page-token", "0"))
    chunk = rows[page * size:(page + 1) * size]
    by_day = {}
    for day, g in chunk:
        by_day.setdefault(day, []).append(g)
    out = {"ResultsByTime": [{"TimePeriod": {"Start": d, "End": d}, "Total": {}, "Groups": gs} for d, gs in by_day.items()]}
    if (page + 1) * size < len(rows):
        out["NextPageToken"] = str(page + 1)
    return out


def main():
    argv = sys.argv[1:]
    with open(os.path.join(STATE_DIR, "calls.jsonl"), "a") as f:
        f.write(json.dumps({"argv": argv}) + "\n")
    with open(os.path.join(STATE_DIR, "fixture.json")) as f:
        fx = json.load(f)
    if argv[0] != "ce":
        fail(argv[0], "UnknownCommand")
    op = argv[1]
    if op in fx.get("fail", {}):
        fail(op, fx["fail"][op])
    if op == "get-cost-and-usage":
        keys = group_keys(argv)
        if any("RECORD_TYPE" in k for k in keys):
            start, end = period(argv)
            res = [{"TimePeriod": {"Start": m, "End": m}, "Total": {},
                    "Groups": [{"Keys": ["Credit"], "Metrics": metrics(v)}]}
                   for m, v in sorted(fx.get("credits", {}).items()) if start[:7] <= m[:7] and m < end]
            out = {"ResultsByTime": res}
        elif any("TAG" in k for k in keys):
            start, end = period(argv)
            out = {"ResultsByTime": [{"TimePeriod": {"Start": start, "End": end}, "Total": {},
                                      "Groups": [{"Keys": [k], "Metrics": metrics(v)} for k, v in fx.get("env", {}).items()]}]}
        else:
            out = usage(fx, argv)
    elif op == "list-cost-allocation-tags":
        out = {"CostAllocationTags": [{"TagKey": k, "Type": "UserDefined", "Status": v} for k, v in fx.get("tags", {}).items()]}
    elif op == "list-cost-allocation-tag-backfill-history":
        b = fx.get("backfill")
        out = {"BackfillRequests": [] if b is None else [
            {"BackfillFrom": "2026-10-01T00:00:00Z", "RequestedAt": "2026-11-04T10:00:00Z", "BackfillStatus": b}]}
    elif op == "get-cost-forecast":
        fc = fx.get("forecast", "0")
        if isinstance(fc, dict):
            fail(op, fc["error"])
        out = {"Total": {"Amount": fc, "Unit": "USD"}, "ForecastResultsByTime": []}
    else:
        fail(op, "UnknownOperation")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
