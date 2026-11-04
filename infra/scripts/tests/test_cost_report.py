#!/usr/bin/env python3
"""Test của infra/scripts/cost-report.py (DBS-143, TC-143-01..12) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_cost_report.py
"""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "cost-report.py"
FAKE_AWS = HERE / "fake_aws_ce.py"
TODAY = "2026-11-04"

RDS = "Amazon Relational Database Service"
CACHE = "Amazon ElastiCache"
ELB = "Amazon Elastic Load Balancing"
ECS = "Amazon Elastic Container Service"
KMS = "AWS Key Management Service"

# Dạng số liệu thật 25/10–03/11 (DBS-143 §1), rút gọn.
BASE = {
    "usage": {
        "2026-10-25": [
            [RDS, "APS1-InstanceUsage:db.t4g.micro", "0.0100", "0.4"],
            [ELB, "APS1-LoadBalancerUsage", "0.0504", "2"],
            [KMS, "ap-southeast-1-KMS-Keys", "0.0300", "0.03"],
        ],
        "2026-10-27": [
            [CACHE, "APS1-NodeUsage:cache.t4g.micro", "0.0192", "1"],
            [KMS, "ap-southeast-1-KMS-Keys", "0.0300", "0.03"],
        ],
        "2026-10-29": [
            [RDS, "APS1-InstanceUsage:db.t4g.micro", "0.0083", "0.334"],
            [ELB, "APS1-LoadBalancerUsage", "0.0504", "2"],
            [KMS, "ap-southeast-1-KMS-Keys", "0.0300", "0.03"],
        ],
        "2026-11-02": [[KMS, "ap-southeast-1-KMS-Keys", "0.0300", "0.03"]],
        "2026-11-03": [[KMS, "ap-southeast-1-KMS-Keys", "0.0300", "0.03"]],
    },
    "tags": {"project": "Inactive", "env": "Inactive", "owner": "Inactive"},
    "credits": {"2026-08-01": "-0.0544", "2026-10-01": "-0.4977", "2026-11-01": "-0.1537"},
    "forecast": "1.9540",
}


class Env:
    """Thư mục trạng thái riêng và PATH có `aws` giả."""

    def __init__(self, fixture):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state = root / "state"
        self.bin = root / "bin"
        self.state.mkdir()
        self.bin.mkdir()
        (self.state / "fixture.json").write_text(json.dumps(fixture))
        aws = self.bin / "aws"
        aws.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_AWS}" "$@"\n')
        aws.chmod(0o755)

    def run(self, *args, today=TODAY):
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_STATE": str(self.state),
            "HOME": self.tmp.name,
            "AWS_PROFILE": "dbs-admin",
            "COST_REPORT_TODAY": today,
        }
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True)

    def calls(self):
        p = self.state / "calls.jsonl"
        return [json.loads(line)["argv"] for line in p.read_text().splitlines()] if p.exists() else []

    def ops(self):
        return [c[1] for c in self.calls()]

    def cleanup(self):
        self.tmp.cleanup()


def arg(argv, name):
    return argv[argv.index(name) + 1]


def line_with(text, needle):
    return next(l for l in text.splitlines() if needle in l)


class CostReport(unittest.TestCase):
    def env(self, **changes):
        fx = copy.deepcopy(BASE)
        fx.update(changes)
        e = Env(fx)
        self.addCleanup(e.cleanup)
        return e

    def ok(self, e, *args):
        p = e.run("--start", "2026-10-01", "--end", TODAY, *args)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    # TC-143-01: đủ 7 dòng DoD theo thứ tự, Data transfer từ service riêng, cộng bằng Decimal
    def test_service_table_has_dod_rows_in_order(self):
        usage = {"2026-11-03": [
            [RDS, "APS1-InstanceUsage:db.t4g.micro", "0.1", "4"],
            [KMS, "ap-southeast-1-KMS-Keys", "0.2", "0.2"],
            ["AWS Data Transfer", "APS1-DataTransfer-Out-Bytes", "0.0050", "0.05"],
        ]}
        out = self.ok(self.env(usage=usage))
        rows = [l.split("|")[1].strip() for l in out.splitlines() if l.startswith("| ")]
        dod = ["RDS", "ElastiCache", "ECS", "ALB", "SQS", "CloudWatch", "Data transfer"]
        self.assertEqual(rows[1:8], dod)
        self.assertIn("0,0000", line_with(out, "| SQS |"))
        self.assertIn("0,1000", line_with(out, "| RDS |"))
        self.assertIn(KMS, out)
        self.assertGreater(rows.index(KMS), rows.index("Data transfer"))
        self.assertIn("0,0050", line_with(out, "| Data transfer |"))
        self.assertIn("0,0000", line_with(out, "trong đó data transfer"))  # service riêng không lặp ở dòng phụ
        self.assertIn("0,3050", line_with(out, "| **Tổng** |"))  # 0,1 + 0,2 + 0,005 đúng từng chữ số

    # TC-143-02: bảng chi phí lọc bỏ Credit/Refund và nhóm SERVICE + USAGE_TYPE; lệnh credit không lọc
    def test_usage_query_excludes_credits(self):
        e = self.env()
        self.ok(e)
        cau = [c for c in e.calls() if c[1] == "get-cost-and-usage"]
        usage = next(c for c in cau if arg(c, "--granularity") == "DAILY")
        self.assertEqual(json.loads(arg(usage, "--filter")),
                         {"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}})
        # AWS CLI chỉ giữ lần `--group-by` cuối: hai nhóm phải nằm sau một cờ (lỗi tìm thấy ở M-143-02)
        self.assertEqual(usage.count("--group-by"), 1)
        i = usage.index("--group-by")
        self.assertEqual(usage[i + 1:i + 3], ["Type=DIMENSION,Key=SERVICE", "Type=DIMENSION,Key=USAGE_TYPE"])
        credit = next(c for c in cau if any("RECORD_TYPE" in a for a in c if a.startswith("Type=")))
        self.assertNotIn("--filter", credit)
        self.assertEqual(arg(credit, "--time-period"), f"Start=2026-08-01,End={TODAY}")

    # TC-143-03: giờ dựng theo usage type, đơn giá riêng từng lớp, ngày có phiên
    def test_session_hours_and_unit_prices(self):
        usage = copy.deepcopy(BASE["usage"])
        usage["2026-10-29"].append([RDS, "APS1-Multi-AZUsage:db.t4g.small", "0.0700", "1"])
        usage["2026-10-29"].append([RDS, "APS1-RDS:GP3-Storage", "0.0027", "0.02"])
        out = self.ok(self.env(usage=usage))
        micro = line_with(out, "InstanceUsage:db.t4g.micro")
        self.assertIn("0,734", micro)
        self.assertIn("0,0249", micro)  # (0,0100 + 0,0083) / 0,734, không gồm storage
        self.assertIn("0,0700", line_with(out, "Multi-AZUsage:db.t4g.small"))
        self.assertIn("0,0192", line_with(out, "NodeUsage:cache.t4g.micro"))
        self.assertIn("0,0252", line_with(out, "LoadBalancerUsage"))
        self.assertIn("RDS:GP3-Storage", out)
        days = line_with(out, "Ngày có phiên")
        self.assertIn("3 ngày", days)
        for d in ("25/10", "27/10", "29/10"):
            self.assertIn(d, days)
        self.assertNotIn("02/11", days)

    # TC-143-04: data transfer ở dịch vụ khác chỉ là dòng phụ, không cộng vào tổng
    def test_transfer_inside_other_services_not_double_counted(self):
        usage = {"2026-11-03": [
            ["EC2 - Other", "APS1-DataTransfer-Out-Bytes", "0.0100", "0.1"],
            ["Amazon Simple Storage Service", "APS1-USE1-AWS-Out-Bytes", "0.0020", "0.1"],
            [KMS, "ap-southeast-1-KMS-Keys", "0.0300", "0.03"],
        ]}
        out = self.ok(self.env(usage=usage))
        self.assertIn("0,0120", line_with(out, "trong đó data transfer"))
        self.assertIn("0,0000", line_with(out, "| Data transfer |"))
        self.assertIn("0,0420", line_with(out, "| **Tổng** |"))

    # TC-143-05: tag env chưa bật / bật đủ dữ liệu / bật nhưng chưa đủ
    def test_env_tag_inactive(self):
        e = self.env()
        out = self.ok(e)
        self.assertIn("Tag `env` chưa bật", out)
        self.assertNotIn("list-cost-allocation-tag-backfill-history", e.ops())
        self.assertFalse(any(a.startswith("Type=TAG") for c in e.calls() for a in c))

    def test_env_tag_active_complete(self):
        out = self.ok(self.env(tags={"project": "Active", "env": "Active", "owner": "Active"},
                               env={"env$dev": "0.60", "env$": "0.05"}, backfill="SUCCEEDED"))
        self.assertIn("0,6000", line_with(out, "| dev |"))
        self.assertIn("0,0500", line_with(out, "| (không tag) |"))
        self.assertNotIn("dữ liệu tag chưa đủ", out)

    def test_env_tag_active_incomplete(self):
        active = {"project": "Active", "env": "Active", "owner": "Active"}
        out = self.ok(self.env(tags=active, env={"env$dev": "0.05", "env$": "0.95"}, backfill="SUCCEEDED"))
        self.assertIn("dữ liệu tag chưa đủ", out)
        out = self.ok(self.env(tags=active, env={"env$dev": "0.60", "env$": "0.05"}, backfill="PROCESSING"))
        self.assertIn("dữ liệu tag chưa đủ", out)

    # TC-143-06: credit từ --credit-since, dự báo B theo tốc độ 7 ngày, CẢNH BÁO khi vượt
    def test_credit_from_credit_since_and_projection_warning(self):
        usage = {d: [[ELB, "APS1-LoadBalancerUsage", "10", "400"]]
                 for d in ("2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03")}
        e = self.env(usage=usage, credits={"2026-08-01": "-0.2081", "2026-10-01": "-0.4977"})
        p = e.run("--start", "2026-10-26", "--end", TODAY, "--project-end", "2026-12-14")
        self.assertEqual(p.returncode, 0, p.stderr)
        out = p.stdout
        self.assertIn("0,7058", line_with(out, "Credit đã dùng"))
        self.assertIn("199,2942", line_with(out, "Credit còn lại"))
        self.assertIn("400,0000", line_with(out, "Dự báo tới cuối dự án"))  # 10 USD/ngày × 40 ngày
        self.assertIn("1,9540", line_with(out, "Dự báo AWS"))
        self.assertIn("CẢNH BÁO", out)
        out = self.ok(self.env())
        self.assertNotIn("CẢNH BÁO", out)

    # TC-143-07: forecast thiếu dữ liệu, khoảng trong quá khứ, dạng request
    def test_forecast_unavailable(self):
        e = self.env(forecast={"error": "DataUnavailableException"})
        out = self.ok(e)
        self.assertIn("không có (Cost Explorer chưa đủ dữ liệu)", line_with(out, "Dự báo AWS"))

    def test_forecast_skipped_for_past_end(self):
        e = self.env()
        p = e.run("--start", "2026-10-01", "--end", "2026-11-02")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("bỏ qua (khoảng trong quá khứ)", line_with(p.stdout, "Dự báo AWS"))
        self.assertNotIn("get-cost-forecast", e.ops())

    def test_forecast_request_shape(self):
        e = self.env()
        self.ok(e)
        fc = next(c for c in e.calls() if c[1] == "get-cost-forecast")
        self.assertEqual(arg(fc, "--metric"), "UNBLENDED_COST")
        self.assertEqual(arg(fc, "--granularity"), "MONTHLY")
        self.assertEqual(arg(fc, "--time-period"), f"Start={TODAY},End=2026-12-01")
        self.assertEqual(json.loads(arg(fc, "--filter")), {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}})

    # TC-143-08: cảnh báo ADR-10, nhắc Down, ngày cuối chưa đủ
    def test_forbidden_usage_and_last_day_reminder(self):
        usage = copy.deepcopy(BASE["usage"])
        usage["2026-10-27"].append(["EC2 - Other", "APS1-NatGateway-Hours", "0.0590", "1"])
        out = self.ok(self.env(usage=usage))
        self.assertIn("CẢNH BÁO ADR-10", out)
        self.assertIn("NatGateway", line_with(out, "CẢNH BÁO ADR-10"))
        self.assertIn("có thể chưa đủ", out)
        self.assertNotIn("chưa xóa", out)

        usage = copy.deepcopy(BASE["usage"])
        usage["2026-10-27"].append(["Amazon Virtual Private Cloud", "APS1-VpcEndpoint-Hours", "0.0130", "1"])
        self.assertIn("VpcEndpoint", line_with(self.ok(self.env(usage=usage)), "CẢNH BÁO ADR-10"))

        for extra in ([ECS, "APS1-Fargate-vCPU-Hours:perCPU", "0.0100", "0.2"], ["AWS WAF", "APS1-WebACL", "0.0070", "0.001"]):
            usage = copy.deepcopy(BASE["usage"])
            usage["2026-11-03"].append(extra)
            self.assertIn("chưa xóa", self.ok(self.env(usage=usage)), extra)

    # TC-143-09: phân trang, gộp theo ngày, không trùng
    def test_pagination_merges_by_day(self):
        e = self.env(page_size=2)
        out = self.ok(e)
        pages = [c for c in e.calls() if c[1] == "get-cost-and-usage" and arg(c, "--granularity") == "DAILY"]
        self.assertGreater(len(pages), 1)
        self.assertIn("--next-page-token", pages[1])
        self.assertIn("0,1500", line_with(out, KMS))  # 5 ngày × 0,03, không mất trang nào
        self.assertIn("0,734", line_with(out, "InstanceUsage:db.t4g.micro"))

    # TC-143-09 (lỗi tìm thấy ở M-143-02): nhóm chỉ có khóa USAGE_TYPE, không có SERVICE
    def test_group_without_service_key(self):
        usage = copy.deepcopy(BASE["usage"])
        usage["2026-10-25"].append([None, "APS2-Catalog-Request", "0.0010", "2"])
        out = self.ok(self.env(usage=usage))
        self.assertIn("0,0010", line_with(out, "| (không rõ dịch vụ) |"))
        usage["2026-10-25"].append(["AWS Glue", "APS1-Catalog-Request", "0", "3"])
        self.assertNotIn("AWS Glue", self.ok(self.env(usage=usage)))  # dịch vụ ngoài DoD có tổng 0 thì ẩn
        self.assertIn("0,2893", line_with(out, "| **Tổng** |"))  # 0,2883 của BASE + 0,0010

    # TC-143-10: tham số sai → thoát 2, không gọi aws
    def test_bad_arguments(self):
        cases = [
            (["--start", "2026-11-04", "--end", "2026-10-01"], "--end"),
            (["--end", "2026-13-01"], "--end"),
            (["--end", "2026-11-06"], "--end"),
            (["--credit-total", "-1"], "--credit-total"),
            (["--end", TODAY, "--project-end", "2026-11-01"], "--project-end"),
            (["--start", "2026-07-01", "--end", TODAY], "--credit-since"),
        ]
        for args, name in cases:
            e = self.env()
            p = e.run(*args)
            self.assertEqual(p.returncode, 2, (args, p.stderr))
            self.assertIn(name, p.stderr)
            self.assertEqual(p.stdout, "")
            self.assertEqual(e.calls(), [], args)

    # TC-143-11: aws lỗi ở lệnh đầu hoặc lệnh cuối → thoát 1, stdout rỗng
    def test_aws_failure_leaves_stdout_empty(self):
        for op, code in (("get-cost-and-usage", "ExpiredTokenException"), ("get-cost-forecast", "AccessDeniedException")):
            p = self.env(fail={op: code}).run("--start", "2026-10-01", "--end", TODAY)
            self.assertEqual(p.returncode, 1, op)
            self.assertEqual(p.stdout, "", op)
            self.assertIn(f"aws ce {op}", p.stderr)
            self.assertIn(code, p.stderr)

    # TC-143-12: --end mặc định là hôm nay UTC; cột 7 ngày = [end − 7, end)
    def test_default_end_and_seven_day_window(self):
        e = self.env()
        p = e.run("--start", "2026-10-01")
        self.assertEqual(p.returncode, 0, p.stderr)
        usage = next(c for c in e.calls() if c[1] == "get-cost-and-usage" and arg(c, "--granularity") == "DAILY")
        self.assertEqual(arg(usage, "--time-period"), f"Start=2026-10-01,End={TODAY}")
        # KMS: lũy kế 5 ngày 0,1500; 7 ngày cuối [28/10, 04/11) có 29/10, 02/11, 03/11 = 0,0900
        kms = line_with(p.stdout, KMS)
        self.assertIn("0,1500", kms)
        self.assertIn("0,0900", kms)
        self.assertIn("28/10", p.stdout)

    def test_summary_block_present(self):
        out = self.ok(self.env())
        self.assertIn("Tóm tắt gửi nhóm", out)
        self.assertIn("Đề xuất cắt giảm", out)
        self.assertNotRegex(out, r"\d{12}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
