#!/usr/bin/env python3
"""Test của .github/scripts/verify-worker-rollout.sh và check-worker-rollout.py (BL-188, TC-188-01..14).

Dùng chung `aws` giả với test_deploy.py (fake_aws_deploy.py). Chạy: python3 .github/scripts/tests/test_verify_worker_rollout.py
Mục tiêu: sau khi deploy xong không còn task worker revision cũ chạy, kể cả task đang STOPPING và deployment cũ còn trong
`deployments`; chỉ khi đó mới được bật phiên bản luật mới (docs/runbooks/risk-config-rollout.md).
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from test_deploy import Env, W_NEW, W_OLD, deployment, service, worker_service  # noqa: E402

VERIFY = HERE.parent / "verify-worker-rollout.sh"
CHECK = HERE.parent / "check-worker-rollout.py"
TASK = "arn:aws:ecs:ap-southeast-1:123456789012:task/dbs-dev/worker%032d"


def task(n, status, td):
    return {"taskArn": TASK % n, "lastStatus": status, "taskDefinitionArn": td}


def described(*tasks):
    return {"tasks": list(tasks), "failures": []}


def worker_svc(td=W_NEW, desired=1, running=None, pending=0, rollout="COMPLETED", extra_deployments=()):
    """worker_service() kèm pendingCount và các deployment cũ còn lại."""
    s = worker_service(td, desired=desired, running=running, state=rollout)
    s["services"][0]["pendingCount"] = pending
    s["services"][0]["deployments"].extend(extra_deployments)
    return s


def old_deployment(status="ACTIVE", td=W_OLD, running=1):
    return {"status": status, "taskDefinition": td, "rolloutState": "COMPLETED", "desiredCount": 1, "runningCount": running}


class VerifyWorkerRollout(unittest.TestCase):
    def make(self, **scenario):
        e = Env(**scenario)
        self.addCleanup(e.cleanup)
        return e

    def verify(self, e, **extra):
        env = {"VERIFY_DEADLINE_SECONDS": "5", "POLL_SECONDS": "0"}
        env.update(extra)
        return e.run(script=VERIFY, **env)

    @staticmethod
    def count(e, op):
        return len([c for c in e.calls() if c["argv"][1] == op])

    # TC-188-01: đường bình thường: một deployment PRIMARY, một task RUNNING ở revision mong đợi
    def test_clean_state_passes(self):
        e = self.make(describe_services_worker=[worker_svc()])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("OK: chỉ còn dbs-worker:3, 1/1 task RUNNING", p.stdout)
        statuses = [c["argv"][c["argv"].index("--desired-status") + 1] for c in e.calls() if c["argv"][1] == "list-tasks"]
        self.assertEqual(sorted(statuses), ["RUNNING", "STOPPED"])  # cả task đang dừng cũng được xét

    # TC-188-02: task cũ còn STOPPING (stopTimeout 60 s vẫn xử lý message) thì phải chờ tới khi STOPPED
    def test_waits_for_old_task_to_stop(self):
        old = TASK % 2
        e = self.make(
            describe_services_worker=[worker_svc()],
            list_tasks_worker={"RUNNING": [[TASK % 1]], "STOPPED": [[old]]},
            describe_tasks_worker=[described(task(1, "RUNNING", W_NEW), task(2, "STOPPING", W_OLD)),
                                   described(task(1, "RUNNING", W_NEW), task(2, "DEACTIVATING", W_OLD)),
                                   described(task(1, "RUNNING", W_NEW), task(2, "STOPPED", W_OLD))])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.count(e, "describe-tasks"), 3)
        self.assertIn("task worker", p.stdout)  # dòng "Chờ worker cũ dừng hẳn" nêu task còn lại
        self.assertIn("STOPPING", p.stdout)

    # TC-188-03: task cũ không bao giờ dừng: đỏ sau hạn, nêu task và revision cũ
    def test_old_task_that_never_stops_is_red(self):
        e = self.make(
            describe_services_worker=[worker_svc()],
            list_tasks_worker={"RUNNING": [[TASK % 1, TASK % 2]], "STOPPED": [[]]},
            describe_tasks_worker=[described(task(1, "RUNNING", W_NEW), task(2, "RUNNING", W_OLD))])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW, VERIFY_DEADLINE_SECONDS="1", POLL_SECONDS="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("vẫn ở dbs-worker:2", p.stdout + p.stderr)
        self.assertIn("::error::", p.stderr)

    # TC-188-04: deployment cũ (ACTIVE) còn trong `deployments` thì chờ; biến mất thì đạt
    def test_waits_for_old_deployment_to_disappear(self):
        e = self.make(describe_services_worker=[worker_svc(extra_deployments=[old_deployment()]),
                                                worker_svc(extra_deployments=[old_deployment("INACTIVE", running=0)]),
                                                worker_svc()])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.count(e, "describe-services"), 3)
        self.assertIn("còn deployment ACTIVE", p.stdout)

    def test_old_deployment_that_stays_is_red(self):
        e = self.make(describe_services_worker=[worker_svc(extra_deployments=[old_deployment()])])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW, VERIFY_DEADLINE_SECONDS="1", POLL_SECONDS="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("còn deployment ACTIVE ở dbs-worker:2", p.stderr)

    # TC-188-05: runningCount < desiredCount hoặc còn pending: chờ (COMPLETED chưa đủ)
    def test_waits_for_running_count_and_pending(self):
        e = self.make(describe_services_worker=[worker_svc(running=0), worker_svc(running=1, pending=1), worker_svc()])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.count(e, "describe-services"), 3)

    # TC-188-06: số task RUNNING ở revision mới phải bằng desiredCount (task mới còn PENDING thì chưa đạt)
    def test_pending_new_task_is_not_enough(self):
        e = self.make(describe_services_worker=[worker_svc()],
                      describe_tasks_worker=[described(task(1, "PENDING", W_NEW)), described(task(1, "RUNNING", W_NEW))])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.count(e, "describe-tasks"), 2)

    # TC-188-07: PRIMARY không phải revision mong đợi (circuit breaker rollback): đỏ ngay, không chờ hết hạn
    def test_primary_on_other_revision_fails_fast(self):
        e = self.make(describe_services_worker=[worker_svc(td=W_OLD)])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW, VERIFY_DEADLINE_SECONDS="60", POLL_SECONDS="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("không phải", p.stderr)
        self.assertEqual(self.count(e, "describe-services"), 1)

    # TC-188-08: không truyền EXPECT_TASK_DEFINITION thì revision mong đợi là của deployment PRIMARY (dùng khi chạy tay)
    def test_defaults_to_primary_revision(self):
        e = self.make(describe_services_worker=[worker_svc(td=W_OLD)],
                      describe_tasks_worker=[described(task(1, "RUNNING", W_OLD))])
        p = self.verify(e)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("chỉ còn dbs-worker:2", p.stdout)
        e = self.make(describe_services_worker=[worker_svc(td=W_NEW)],
                      describe_tasks_worker=[described(task(1, "RUNNING", W_NEW), task(2, "RUNNING", W_OLD))])
        p = self.verify(e, VERIFY_DEADLINE_SECONDS="1", POLL_SECONDS="1")
        self.assertNotEqual(p.returncode, 0)  # bản chạy tay vẫn bắt được worker cũ
        self.assertIn("vẫn ở dbs-worker:2", p.stderr)

    # TC-188-09: service không có hoặc không ACTIVE: không có worker nào chạy, cảnh báo, thoát 0, không list-tasks
    def test_missing_service_is_a_warning(self):
        for sc in ({"services": [], "failures": [{"arn": "x", "reason": "MISSING"}]}, worker_service(status="INACTIVE")):
            e = self.make(describe_services_worker=[sc])
            p = self.verify(e)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertIn("::warning::", p.stderr)
            self.assertEqual(self.count(e, "describe-tasks"), 0)

    # TC-188-10: desiredCount = 0: không có task thì đạt, và không gọi describe-tasks với danh sách rỗng (AWS báo lỗi)
    def test_desired_zero_without_tasks_passes_without_describe_tasks(self):
        e = self.make(describe_services_worker=[worker_svc(desired=0, running=0)],
                      list_tasks_worker={"RUNNING": [[]], "STOPPED": [[]]})
        p = self.verify(e)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.count(e, "describe-tasks"), 0)
        self.assertIn("0/0 task RUNNING", p.stdout)

    def test_desired_zero_with_leftover_old_task_waits(self):
        e = self.make(describe_services_worker=[worker_svc(td=W_NEW, desired=0, running=0)],
                      list_tasks_worker={"RUNNING": [[]], "STOPPED": [[TASK % 2]]},
                      describe_tasks_worker=[described(task(2, "STOPPING", W_OLD)), described(task(2, "STOPPED", W_OLD))])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.count(e, "describe-tasks"), 2)

    # TC-188-11: task đã STOPPED ở revision cũ (lịch sử) không làm đỏ
    def test_stopped_old_tasks_are_history(self):
        e = self.make(describe_services_worker=[worker_svc()],
                      list_tasks_worker={"RUNNING": [[TASK % 1]], "STOPPED": [[TASK % 2, TASK % 3]]},
                      describe_tasks_worker=[described(task(1, "RUNNING", W_NEW), task(2, "STOPPED", W_OLD), task(3, "STOPPED", W_OLD))])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    # TC-188-12: lỗi AWS (AccessDenied) làm script đỏ, không bị nuốt thành "đạt"
    def test_aws_error_is_red(self):
        for op in ("ecs describe-services", "ecs list-tasks", "ecs describe-tasks"):
            e = self.make(describe_services_worker=[worker_svc()],
                          error={"op": op, "worker": True, "code": "AccessDeniedException"})
            p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
            self.assertNotEqual(p.returncode, 0, op)

    # TC-188-13: helper thuần (không AWS): mã thoát 0/1/2/3
    def test_check_helper_exit_codes(self):
        def run(svc, tasks, *extra):
            with tempfile.TemporaryDirectory() as d:
                a, b = pathlib.Path(d, "s.json"), pathlib.Path(d, "t.json")
                a.write_text(json.dumps(svc))
                b.write_text(json.dumps(tasks))
                return subprocess.run([sys.executable, str(CHECK), "--service", str(a), "--tasks", str(b), *extra],
                                      capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run(worker_svc(), described(task(1, "RUNNING", W_NEW))).returncode, 0)
        self.assertEqual(run(worker_svc(), described(task(1, "RUNNING", W_NEW), task(2, "RUNNING", W_OLD))).returncode, 1)
        self.assertEqual(run(worker_svc(), described(task(1, "RUNNING", W_NEW)), "--expect", W_OLD).returncode, 2)
        self.assertEqual(run({"services": []}, described()).returncode, 3)
        self.assertEqual(run(worker_svc(rollout="IN_PROGRESS"), described(task(1, "RUNNING", W_NEW))).returncode, 1)

    # TC-188-14: api service không bị xét (fixture api có cùng định dạng nhưng script chỉ nhìn service worker)
    def test_only_worker_service_is_queried(self):
        e = self.make(describe_services_worker=[worker_svc()], describe_services=[service(), service(deployments=deployment("x", "FAILED"))])
        p = self.verify(e, EXPECT_TASK_DEFINITION=W_NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertTrue(all("worker" in c["argv"] for c in e.calls() if c["argv"][1] in ("describe-services", "list-tasks")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
