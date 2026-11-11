import http from "k6/http";
import { check } from "k6";
import { workload, sameCompletedBodies } from "./lib/config.js";
import {
  fixture,
  transferRequest,
  transfer,
  key,
  record,
  json,
  bursts,
} from "./lib/client.js";
export const options = workload("duplicate", __ENV.SMOKE === "1");
export default function () {
  const idem = key(),
    from = fixture.customers[0],
    to = fixture.customers[1];
  bursts.add(1);
  // batchPerHost=10 releases all duplicates together, including when only one VU is active.
  const responses = http.batch(
    Array.from({ length: 10 }, () => transferRequest(from, to, idem)),
  );
  for (const response of responses) record(response, true);
  check(responses, {
    "10 parallel copies same201 body": (rs) =>
      rs.length === 10 &&
      rs.every((r) => r.status === 201) &&
      sameCompletedBodies(rs.map(json)),
  });
  const changed = transfer(from, to, idem, "2000");
  check(changed, {
    "changed amount422 IDEMPOTENCY_KEY_REUSED": (r) =>
      r.status === 422 && json(r).errorCode === "IDEMPOTENCY_KEY_REUSED",
  });
}
