import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { AMOUNT, validateFixture } from "./config.js";

export const fixture = validateFixture(
  JSON.parse(open(__ENV.LOAD_FIXTURE)),
  __ENV.BASE_URL,
);
export const errors = new Rate("system_errors");
export const readLatency = new Trend("read_latency", true);
export const transferLatency = new Trend("transfer_latency", true);
export const bursts = new Counter("duplicate_bursts");
http.setResponseCallback(http.expectedStatuses(200, 201, 422, 429));

export function key(suffix = "") {
  return `${__ENV.LOAD_RUN_ID}:${exec.scenario.name}:${exec.scenario.iterationInTest}${suffix}`;
}
export function params(customer, name, idempotencyKey) {
  return {
    headers: {
      Authorization: `Bearer ${customer.token}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    tags: { name },
    timeout: "2s",
    redirects: 0,
  };
}
export function json(response) {
  try {
    return response.json();
  } catch {
    return {};
  }
}
export function record(response, transfer = false, operation = "") {
  const validStatus = [200, 201, 422, 429].includes(response.status);
  errors.add(!validStatus);
  if (transfer) transferLatency.add(response.timings.duration);
  else if (operation) readLatency.add(response.timings.duration, { operation });
  return response;
}
export function transferRequest(from, to, idem = key(), amount = AMOUNT) {
  return {
    method: "POST",
    url: `${fixture.baseUrl}/v1/transfers`,
    body: JSON.stringify({
      fromAccountId: from.accountId,
      toAccountId: to.accountId,
      amount,
    }),
    params: params(from, "POST /v1/transfers", idem),
  };
}
export function transfer(
  from,
  to,
  idem = key(),
  amount = AMOUNT,
  baseUrl = fixture.baseUrl,
) {
  const req = transferRequest(from, to, idem, amount);
  const response = record(
    http.post(`${baseUrl}/v1/transfers`, req.body, req.params),
    true,
  );
  return response;
}
export function completed(response) {
  check(response, {
    "transfer201 COMPLETED": (r) =>
      r.status === 201 &&
      json(r).status === "COMPLETED" &&
      typeof json(r).transferId === "string",
  });
}
export function write() {
  const i = exec.scenario.iterationInTest % fixture.customers.length;
  completed(
    transfer(
      fixture.customers[i],
      fixture.customers[(i + 1) % fixture.customers.length],
    ),
  );
}
export function read() {
  const i = exec.scenario.iterationInTest;
  const customer = fixture.customers[i % fixture.customers.length];
  const operation = i % 2 ? "history" : "balance";
  const path = `/v1/accounts/${customer.accountId}${operation === "history" ? "/transactions?limit=20" : ""}`;
  const response = record(
    http.get(
      `${fixture.baseUrl}${path}`,
      params(
        customer,
        `GET /v1/accounts/:id${operation === "history" ? "/transactions" : ""}`,
      ),
    ),
    false,
    operation,
  );
  check(response, {
    "read200 expected shape": (r) =>
      r.status === 200 &&
      (operation === "history"
        ? Array.isArray(json(r).items)
        : typeof json(r).balance === "string"),
  });
}
