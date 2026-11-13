export const SCENARIOS = [
  "baseline",
  "hot-account",
  "duplicate",
  "stress",
  "rate-limit",
];
export const AMOUNT = "1000";
export const SYSTEM_TAGS = [
  "status",
  "method",
  "name",
  "scenario",
  "expected_response",
];

export function sameCompletedBodies(bodies) {
  const first = bodies[0];
  return (
    bodies.length > 0 &&
    bodies.every(
      (b) =>
        b &&
        Object.keys(b).length === 2 &&
        typeof b.transferId === "string" &&
        b.transferId === first.transferId &&
        b.status === "COMPLETED",
    )
  );
}

export function workload(kind, smoke = false) {
  if (!SCENARIOS.includes(kind)) throw new Error("Unknown load scenario");
  const thresholds = { checks: ["rate==1"], system_errors: ["rate<0.001"] };
  const options = {
    scenarios: {},
    thresholds,
    systemTags: SYSTEM_TAGS,
    batch: 10,
    batchPerHost: 10,
  };
  const profile = smoke ? "smoke" : "full";
  const arrival = (
    rate,
    timeUnit,
    duration,
    exec,
    plateau,
    startTime = "0s",
  ) => ({
    executor: "constant-arrival-rate",
    rate,
    timeUnit,
    duration,
    exec,
    startTime,
    preAllocatedVUs: smoke ? 10 : 100,
    maxVUs: smoke ? 20 : 300,
    gracefulStop: "10s",
    tags: { plateau: String(plateau), profile },
  });
  if (kind === "rate-limit") {
    options.scenarios.boundary = {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "180s",
      tags: { profile },
    };
  } else {
    thresholds.dropped_iterations = ["count==0"];
    if (kind === "baseline" || kind === "stress") {
      const rates = smoke
        ? [5]
        : kind === "baseline"
          ? [12, 60, 120]
          : [120, 180, 240];
      const seconds = smoke ? 5 : kind === "baseline" ? 900 : 300;
      rates.forEach((rate, i) => {
        options.scenarios[`read_${rate}`] = arrival(
          rate * 4,
          "5s",
          `${seconds}s`,
          "read",
          rate,
          `${i * (seconds + 10)}s`,
        );
        options.scenarios[`write_${rate}`] = arrival(
          rate,
          "5s",
          `${seconds}s`,
          "write",
          rate,
          `${i * (seconds + 10)}s`,
        );
        for (const operation of ["balance", "history"]) {
          thresholds[`read_latency{plateau:${rate},operation:${operation}}`] = [
            "p(95)<150",
          ];
        }
        thresholds[`transfer_latency{plateau:${rate}}`] = [
          "p(95)<300",
          "p(99)<1000",
        ];
      });
    } else if (kind === "hot-account") {
      options.scenarios.hot = arrival(
        smoke ? 2 : 20,
        "1s",
        smoke ? "5s" : "900s",
        "default",
        smoke ? 2 : 20,
      );
      thresholds.transfer_latency = ["p(95)<1000"];
    } else {
      options.scenarios.duplicates = arrival(
        1,
        "1s",
        smoke ? "3s" : "60s",
        "default",
        1,
      );
      thresholds.transfer_latency = ["p(95)<300"];
    }
  }
  return options;
}

export function durationSeconds(kind, smoke = false) {
  if (kind === "rate-limit") return 180;
  if (smoke) return 30;
  return kind === "baseline"
    ? 2750
    : kind === "stress"
      ? 950
      : kind === "hot-account"
        ? 930
        : 90;
}

export function maxTransfers(kind, smoke = false) {
  if (smoke) return kind === "rate-limit" ? 10 : 12;
  // Arrival executors may release a final iteration on the duration boundary.
  return {
    baseline: 34563,
    stress: 32403,
    "hot-account": 18001,
    duplicate: 61,
    "rate-limit": 10,
  }[kind];
}

/**
 * The per-customer daily limit of the target. The backend default is 200000000
 * (TRANSFER_LIMIT_PER_DAY); a load environment that lowers it must export the same value to the
 * runner, otherwise the preflight would pass and the run would receive 422s.
 */
export function dailyLimit(env = process.env) {
  const raw = env.TRANSFER_LIMIT_PER_DAY ?? "200000000";
  if (!/^[1-9][0-9]{0,18}$/.test(raw))
    throw new Error("Invalid TRANSFER_LIMIT_PER_DAY");
  return BigInt(raw);
}

export function requireBudget(row, transfers, limit = dailyLimit()) {
  const required = BigInt(transfers) * BigInt(AMOUNT);
  if (BigInt(row.balance) < required || BigInt(row.spent) + required > limit) {
    throw new Error(
      "Insufficient balance or remaining daily budget; use a fresh dedicated database",
    );
  }
}

export function cleanUrl(raw) {
  if (typeof raw !== "string" || !/^https?:\/\/[^\s?#@]+$/.test(raw))
    throw new Error("Invalid fixture URL");
  return raw.replace(/\/+$/, "");
}

/**
 * Every fixture token must belong to its customer and stay valid until the run (and a minute more)
 * has ended; the claims are read from the payload only, the signature is the target's business.
 */
export function assertTokensOutliveRun(fixture, runSeconds, nowMs = Date.now()) {
  for (const c of fixture.customers) {
    const claims = JSON.parse(
      Buffer.from(c.token.split(".")[1], "base64url").toString(),
    );
    if (
      claims.sub !== c.sub ||
      !Number.isFinite(claims.exp) ||
      claims.exp < nowMs / 1000 + runSeconds + 60
    )
      throw new Error("Token expires before run ends");
  }
}

export function validateFixture(fixture, baseUrl) {
  if (
    !fixture ||
    !Array.isArray(fixture.customers) ||
    fixture.customers.length !== 3
  )
    throw new Error("Invalid fixture customers");
  if (cleanUrl(fixture.baseUrl) !== cleanUrl(baseUrl))
    throw new Error("Fixture target mismatch");
  const ids = new Set();
  for (const c of fixture.customers) {
    if (
      !/^[0-9a-f-]{36}$/i.test(c.accountId || "") ||
      !c.sub ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(c.token || "")
    )
      throw new Error("Invalid fixture account/token");
    ids.add(c.accountId);
  }
  if (ids.size !== 3) throw new Error("Fixture must contain distinct accounts");
  return fixture;
}
