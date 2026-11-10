import http from "k6/http";
import { check, sleep } from "k6";
import { workload } from "./lib/config.js";
import {
  fixture,
  transfer,
  completed,
  key,
  params,
  record,
  json,
} from "./lib/client.js";
export const options = workload("rate-limit", __ENV.SMOKE === "1");
function freshWindow() {
  sleep((60000 - (Date.now() % 60000)) / 1000 + 1);
  return Math.floor(Date.now() / 60000);
}
function limited(response) {
  const retry = Number(response.headers["Retry-After"]);
  check(response, {
    "429 RATE_LIMITED problem+json Retry-After": (r) =>
      r.status === 429 &&
      json(r).errorCode === "RATE_LIMITED" &&
      String(r.headers["Content-Type"]).includes("application/problem+json") &&
      retry >= 1 &&
      retry <= 60,
  });
}
export default function () {
  const urls = [fixture.baseUrl, __ENV.API_URL_2 || fixture.baseUrl];
  const from = fixture.customers[0],
    to = fixture.customers[1];
  let minute = freshWindow();
  for (let i = 0; i < 11; i++) {
    const r = transfer(from, to, key(`:${i}`), "1000", urls[i % 2]);
    if (i < 10) completed(r);
    else limited(r);
  }
  check(null, {
    "user burst stayed within one minute": () =>
      minute === Math.floor(Date.now() / 60000),
  });
  minute = freshWindow();
  for (let i = 0; i < 101; i++) {
    const r = record(
      http.get(
        `${urls[i % 2]}/v1/accounts/${from.accountId}`,
        params(from, "GET /v1/accounts/:id"),
      ),
    );
    if (i < 100) check(r, { "IP first100 read200": (v) => v.status === 200 });
    else limited(r);
  }
  check(null, {
    "IP burst stayed within one minute": () =>
      minute === Math.floor(Date.now() / 60000),
  });
}
