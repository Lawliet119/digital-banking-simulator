import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateFraudDataset } from "./generate-fraud.mjs";
import { inspectDataset } from "./inspect-fraud.mjs";
import { planScenarios } from "./scenarios.mjs";

const DAY = 86400000,
  HOUR = 3600000;
const fraudNames = [
  "ATO_DRAIN",
  "MULE_FANOUT",
  "VELOCITY_BURST",
  "BUST_OUT",
  "ROUND_TRIP",
  "SLOW_DRIP",
  "STRUCTURING",
  "FAN_IN",
];
let cache;
const data = () => (cache ??= generateFraudDataset());
const parse = (d) =>
  d.csv
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => {
      const r = line.split(",");
      return {
        id: r[0],
        at: Date.parse(r[1]),
        from: r[2],
        to: r[3],
        owner: r[4],
        targetOwner: r[5],
        amount: BigInt(r[6]),
        before: BigInt(r[7]),
        created: Date.parse(r[8]),
        label: r[10],
        scenario: r[11],
      };
    });
const groups = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()];
};
const named = (name) => {
  const rows = parse(data()),
    selected = rows.filter((r) => r.scenario === name);
  assert.ok(selected.length > 0, `missing ${name}`);
  return { rows, selected };
};
function isRoundTrip(forward, back) {
  return (
    forward.from === back.to &&
    forward.to === back.from &&
    back.at > forward.at &&
    back.at - forward.at < HOUR &&
    forward.amount === back.amount
  );
}
function medianTwice(history) {
  const sorted = history
      .map((r) => r.amount)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] * 2n : sorted[n / 2 - 1] + sorted[n / 2];
}
function noRuleHits(row, all) {
  const history = all.filter((r) => r.from === row.from && r.at < row.at),
    last30 = history.filter((r) => r.at >= row.at - 30 * DAY);
  assert.ok(
    all.filter(
      (r) => r.from === row.from && r.at >= row.at - 600000 && r.at <= row.at,
    ).length <= 5,
    "R1",
  );
  assert.ok(last30.length >= 5, "adequate warmup");
  assert.ok(row.amount * 2n <= 5n * medianTwice(last30), "R2");
  assert.ok(row.at - row.created >= DAY, "R3");
  assert.ok(
    !all.some(
      (r) =>
        r.from === row.to &&
        r.to === row.from &&
        r.at >= row.at - HOUR &&
        r.at < row.at,
    ),
    "R4",
  );
  const recent = all.filter(
    (r) => r.from === row.from && r.at >= row.at - HOUR && r.at <= row.at,
  );
  const newTargets = new Set(
    recent
      .filter(
        (r) =>
          !all.some(
            (h) =>
              h.from === r.from &&
              h.to === r.to &&
              h.at >= r.at - 30 * DAY &&
              h.at < r.at,
          ),
      )
      .map((r) => r.to),
  );
  assert.ok(newTargets.size < 5, "R5");
  assert.ok(row.before < 1000000n || row.amount * 10n < row.before * 9n, "R6");
}

test("TC-126-02: ATO has six outgoing, five new recipients and a real drain", () => {
  const { rows, selected } = named("ATO_DRAIN");
  for (const outgoing of groups(selected, (r) => r.from)) {
    assert.ok(outgoing.length >= 6);
    assert.ok(outgoing.at(-1).at - outgoing[0].at < 600000);
    assert.ok(new Set(outgoing.map((r) => r.to)).size >= 5);
    assert.ok(
      outgoing.every(
        (r) =>
          r.owner !== r.targetOwner &&
          !rows.some(
            (h) =>
              h.from === r.from &&
              h.to === r.to &&
              h.at < outgoing[0].at &&
              h.at >= r.at - 30 * DAY,
          ),
      ),
    );
    assert.ok(
      outgoing.some(
        (r) => r.before >= 1000000n && r.amount * 10n >= r.before * 9n,
      ),
    );
  }
});

test("TC-126-02: mule is funded by incoming money before six outgoing", () => {
  const { rows, selected } = named("MULE_FANOUT");
  const sources = new Set(selected.map((r) => r.from));
  for (const mule of new Set(
    selected.filter((r) => sources.has(r.to)).map((r) => r.to),
  )) {
    const incoming = selected.filter((r) => r.to === mule),
      outgoing = selected.filter((r) => r.from === mule);
    assert.ok(outgoing.length >= 6);
    assert.ok(outgoing.at(-1).at - outgoing[0].at < 600000);
    assert.ok(new Set(outgoing.map((r) => r.to)).size >= 5);
    assert.ok(
      outgoing.every(
        (r) =>
          r.owner !== r.targetOwner &&
          !rows.some(
            (h) =>
              h.from === mule &&
              h.to === r.to &&
              h.at < outgoing[0].at &&
              h.at >= r.at - 30 * DAY,
          ),
      ),
    );
    assert.ok(incoming.every((r) => r.at < outgoing[0].at));
    assert.equal(
      outgoing[0].before,
      incoming.reduce((s, r) => s + r.amount, 0n),
    );
    assert.equal(
      outgoing.reduce((s, r) => s + r.amount, 0n),
      outgoing[0].before,
    );
    assert.equal(
      data().simulation.accounts.find((a) => a.accountId === mule)
        .openingBalance,
      "0",
    );
    assert.ok(
      !data().simulation.credits.some(
        (c) =>
          c.accountId === mule && Date.parse(c.occurredAt) < outgoing[0].at,
      ),
    );
  }
  assert.ok(selected.some((r) => sources.has(r.to)));
});

test("TC-126-02: velocity contains six actual small outgoing in ten minutes", () => {
  const { selected } = named("VELOCITY_BURST");
  for (const g of groups(selected, (r) => r.from)) {
    assert.ok(g.length >= 6 && g.at(-1).at - g[0].at < 600000);
    assert.ok(g.every((r) => r.amount >= 50000n && r.amount <= 500000n));
  }
});

test("TC-126-02: bust-out is new, large, funded after opening and drains", () => {
  const { rows, selected } = named("BUST_OUT");
  const start = Date.parse(data().simulation.startAt);
  for (const r of selected) {
    assert.ok(r.created > start && r.created < r.at && r.at - r.created < DAY);
    assert.ok(r.amount > 10000000n && r.amount * 10n >= r.before * 9n);
    assert.ok(!rows.some((h) => h.from === r.from && h.at < r.created));
    assert.equal(
      data().simulation.accounts.find((a) => a.accountId === r.from)
        .openingBalance,
      "0",
    );
  }
});

test("TC-126-02: round-trip has an actual strictly later return of equal money", () => {
  const { selected } = named("ROUND_TRIP");
  assert.equal(selected.length % 2, 0);
  assert.ok(selected.every((r) => r.owner !== r.targetOwner));
  for (let i = 0; i < selected.length; i += 2)
    assert.ok(isRoundTrip(selected[i], selected[i + 1]));
  assert.equal(
    isRoundTrip(selected[0], { ...selected[1], at: selected[0].at }),
    false,
  );
});

for (const scenario of ["SLOW_DRIP", "STRUCTURING", "FAN_IN"]) {
  test(`TC-126-03: ${scenario} has its intended shape and no v1 source rule trigger`, () => {
    const { rows, selected } = named(scenario);
    const bySource = new Map();
    for (const r of rows) {
      if (!bySource.has(r.from)) bySource.set(r.from, []);
      bySource.get(r.from).push(r);
    }
    for (const r of selected) {
      // Histories only for this source and its reverse candidates; other accounts cannot affect these predicates.
      const related = [
        ...bySource.get(r.from),
        ...rows.filter((h) => h.from === r.to && h.to === r.from),
      ];
      noRuleHits(r, related);
    }
    if (scenario === "SLOW_DRIP")
      for (const g of groups(selected, (r) => r.from)) {
        assert.ok(
          new Set(g.map((r) => Math.floor((r.at + 7 * HOUR) / DAY))).size >= 7,
        );
        assert.equal(
          new Set(g.map((r) => Math.floor((r.at + 7 * HOUR) / DAY))).size,
          g.length,
        );
        assert.equal(new Set(g.map((r) => r.to)).size, 1);
        assert.ok(g.every((r) => r.amount >= 50000n && r.amount <= 200000n));
      }
    if (scenario === "STRUCTURING")
      for (const g of groups(selected, (r) => r.from)) {
        assert.ok(
          rows.some(
            (r) => r.from === g[0].from && r.to === g[0].to && r.at < g[0].at,
          ),
        );
        assert.ok(
          g.length >= 6 &&
            new Set(g.map((r) => Math.floor((r.at + 7 * HOUR) / DAY))).size >=
              3,
        );
        assert.ok(g.every((r) => r.amount >= 9500000n && r.amount <= 9900000n));
        for (let i = 1; i < g.length; i++)
          assert.ok(g[i].at - g[i - 1].at >= 2 * HOUR);
      }
    if (scenario === "FAN_IN")
      for (const g of groups(selected, (r) => r.to)) {
        assert.ok(new Set(g.map((r) => r.from)).size >= 6);
        assert.equal(new Set(g.map((r) => r.from)).size, g.length);
        for (const r of g)
          assert.ok(
            g.some(
              (anchor) =>
                anchor.at <= r.at &&
                r.at - anchor.at <= HOUR &&
                new Set(
                  g
                    .filter(
                      (h) => h.at >= anchor.at && h.at <= anchor.at + HOUR,
                    )
                    .map((h) => h.from),
                ).size >= 6,
            ),
          );
      }
  });
}

test("TC-126-09: history median keeps a half dong exactly", () => {
  assert.equal(
    medianTwice([
      { amount: 1n },
      { amount: 2n },
      { amount: 3n },
      { amount: 4n },
      { amount: 5n },
      { amount: 6n },
    ]),
    7n,
  );
  assert.equal(17n * 2n <= 5n * 7n, true);
  assert.equal(18n * 2n <= 5n * 7n, false);
});

test("TC-126-05/06/07: emitted fraud prevalence, labels, IDs and independently replayed totals", () => {
  const d = data(),
    report = inspectDataset(d.csv, d.simulation),
    rows = parse(d);
  for (const name of fraudNames)
    assert.ok(report.scenarioCounts[name] > 0, name);
  assert.ok(report.fraudRate >= 0.008 && report.fraudRate <= 0.012);
  assert.deepEqual(d.stats, report);
  assert.ok(
    rows
      .filter((r) => fraudNames.includes(r.scenario))
      .every((r) => r.label === "1"),
  );
  assert.equal(d.simulation.customers.length, 2000);
  const sourceScenarios = new Map();
  for (const r of rows.filter((r) => fraudNames.includes(r.scenario))) {
    assert.ok(
      !sourceScenarios.has(r.from) ||
        sourceScenarios.get(r.from) === r.scenario,
    );
    sourceScenarios.set(r.from, r.scenario);
  }
});

test("TC-126-04: rent has small prior history and genuinely monthly payments", () => {
  const { rows, selected } = named("HN_RENT");
  assert.ok(selected.length >= 2);
  for (const g of groups(selected, (r) => r.from)) {
    assert.equal(new Set(g.map((r) => r.to)).size, 1);
    for (let i = 0; i < g.length; i++) {
      const r = g[i],
        history = rows.filter(
          (h) => h.from === r.from && h.at < r.at && h.at >= r.at - 30 * DAY,
        );
      assert.ok(history.length >= 5);
      assert.ok(r.amount * 2n > 5n * medianTwice(history));
      assert.ok(r.amount >= 5000000n && r.amount <= 15000000n);
      if (i)
        assert.ok(
          g[i].at - g[i - 1].at >= 28 * DAY &&
            g[i].at - g[i - 1].at <= 31 * DAY,
        );
    }
  }
});
test("TC-126-04: self transfer uses two distinct real accounts with the same owner", () => {
  const { selected } = named("HN_SELF_TRANSFER");
  for (const r of selected) {
    assert.notEqual(r.from, r.to);
    assert.equal(r.owner, r.targetOwner);
    assert.ok(r.before >= 1000000n && r.amount * 10n >= r.before * 9n);
    assert.equal(
      data().simulation.accounts.find((a) => a.accountId === r.to).customerId,
      r.owner,
    );
  }
});
test("TC-126-04: new salary customer is funded before a large same-day transfer", () => {
  const { rows, selected } = named("HN_NEW_SALARY"),
    simulation = data().simulation;
  for (const r of selected) {
    assert.ok(
      r.created > Date.parse(simulation.startAt) && r.at - r.created < DAY,
    );
    assert.ok(r.amount > 10000000n);
    assert.ok(
      simulation.credits.some(
        (c) =>
          c.accountId === r.from &&
          c.kind === "salary" &&
          Date.parse(c.occurredAt) >= r.created &&
          Date.parse(c.occurredAt) < r.at,
      ),
    );
    assert.ok(
      !rows.some(
        (h) => (h.from === r.from || h.to === r.from) && h.at < r.created,
      ),
    );
    assert.equal(
      Date.parse(
        simulation.customers.find((c) => c.customerId === r.owner).createdAt,
      ),
      r.created,
    );
  }
});
test("TC-126-04: group meal pays five new friends in one sitting", () => {
  const { rows, selected } = named("HN_GROUP_MEAL");
  for (const g of groups(selected, (r) => r.from)) {
    assert.ok(
      new Set(g.map((r) => r.to)).size >= 5 && g.at(-1).at - g[0].at <= HOUR,
    );
    assert.ok(
      g.every(
        (r) =>
          r.owner !== r.targetOwner &&
          r.amount >= 50000n &&
          r.amount <= 500000n,
      ),
    );
    assert.ok(
      g.every(
        (r) =>
          !rows.some(
            (h) =>
              h.from === r.from &&
              h.to === r.to &&
              h.at < g[0].at &&
              h.at >= r.at - 30 * DAY,
          ),
      ),
    );
  }
});
test("TC-126-04: borrow and repay has a later equal return on the same Vietnamese day", () => {
  const { selected } = named("HN_BORROW_REPAY");
  for (let i = 0; i < selected.length; i += 2) {
    assert.ok(isRoundTrip(selected[i], selected[i + 1]));
    assert.equal(
      Math.floor((selected[i].at + 7 * HOUR) / DAY),
      Math.floor((selected[i + 1].at + 7 * HOUR) / DAY),
    );
  }
  assert.equal(
    isRoundTrip(selected[0], { ...selected[1], at: selected[0].at }),
    false,
  );
});

test("TC-126-05: all fraud and hard-negative labels, seeds and minimum supported configuration", () => {
  for (const options of [
    {},
    { seed: "dbs-fraud-v2" },
    { seed: "dbs-fraud-edge" },
    { customers: 1000, days: 30 },
  ]) {
    const d = Object.keys(options).length
        ? generateFraudDataset(options)
        : data(),
      r = inspectDataset(d.csv, d.simulation);
    assert.ok(
      r.fraudRate >= 0.008 && r.fraudRate <= 0.012,
      JSON.stringify(options),
    );
    for (const n of [
      ...fraudNames,
      "HN_RENT",
      "HN_SELF_TRANSFER",
      "HN_NEW_SALARY",
      "HN_GROUP_MEAL",
      "HN_BORROW_REPAY",
    ])
      assert.ok(r.scenarioCounts[n] > 0, n);
    assert.ok(
      parse(d)
        .filter((r) => r.scenario.startsWith("HN_"))
        .every((r) => r.label === "0"),
    );
  }
});

test("TC-126-05: insufficient cohort rejects rather than silently dropping episodes", () => {
  assert.throws(() =>
    planScenarios({ seed: "capacity", customers: 1, days: 30, budget: 100 }),
  );
});

test("TC-126-01/10/12: real CLI artifacts reproduce across output paths and timezones", () => {
  const dir = mkdtempSync(join(tmpdir(), "dbs126-"));
  const generator = fileURLToPath(
    new URL("./generate-fraud.mjs", import.meta.url),
  );
  const inspector = fileURLToPath(
    new URL("./inspect-fraud.mjs", import.meta.url),
  );
  const outputs = ["a", "b", "c"].map((n) => join(dir, `${n}.csv`));
  const summaries = [];
  for (let i = 0; i < 3; i++) {
    const result = spawnSync(
      process.execPath,
      [
        generator,
        "--customers",
        "1000",
        "--days",
        "30",
        "--seed",
        i === 2 ? "changed" : "dbs-reproduce",
        "--output",
        outputs[i],
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: i === 0 ? "UTC" : "Asia/Ho_Chi_Minh" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(outputs[i]), "CLI must create CSV");
    summaries.push(JSON.parse(result.stdout));
  }
  for (const suffix of ["", ".simulation.json", ".stats.json"]) {
    assert.equal(
      readFileSync(outputs[0] + suffix, "utf8"),
      readFileSync(outputs[1] + suffix, "utf8"),
    );
    assert.notEqual(
      readFileSync(outputs[0] + suffix, "utf8"),
      readFileSync(outputs[2] + suffix, "utf8"),
    );
  }
  assert.equal(
    summaries[0].sha256,
    createHash("sha256").update(readFileSync(outputs[0])).digest("hex"),
  );
  assert.deepEqual(
    summaries[0],
    JSON.parse(readFileSync(outputs[0] + ".stats.json", "utf8")),
  );
  const inspected = spawnSync(
    process.execPath,
    [
      inspector,
      "--csv",
      outputs[0],
      "--simulation",
      outputs[0] + ".simulation.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.deepEqual(JSON.parse(inspected.stdout), summaries[0]);
  const broken = readFileSync(outputs[0], "utf8").split("\n"),
    row = broken[1].split(",");
  row[7] = String(BigInt(row[7]) - 1n);
  broken[1] = row.join(",");
  writeFileSync(join(dir, "broken.csv"), broken.join("\n"));
  const rejected = spawnSync(
    process.execPath,
    [
      inspector,
      "--csv",
      join(dir, "broken.csv"),
      "--simulation",
      outputs[0] + ".simulation.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  for (const args of [
    [],
    ["--csv"],
    ["--csv", outputs[0], "--csv", outputs[0]],
    ["--unknown", "x"],
  ]) {
    assert.equal(
      spawnSync(process.execPath, [inspector, ...args], { encoding: "utf8" })
        .status,
      1,
    );
  }
});

test("TC-126-11: invalid input rejects without modifying sentinel or creating sidecars", () => {
  const dir = mkdtempSync(join(tmpdir(), "dbs126-invalid-")),
    output = join(dir, "sentinel.csv");
  writeFileSync(output, "unchanged");
  const script = fileURLToPath(
    new URL("./generate-fraud.mjs", import.meta.url),
  );
  const bad = [
    ["--customers", "999"],
    ["--customers", "100001"],
    ["--customers", "1.5"],
    ["--customers", "NaN"],
    ["--days", "29"],
    ["--days", "91"],
    ["--days", "30.5"],
    ["--days", "NaN"],
    ["--seed", ""],
    ["--seed", "x".repeat(129)],
    ["--unknown", "x"],
    ["--days"],
    ["--seed", "a", "--seed", "b"],
  ];
  for (const args of bad) {
    const result = spawnSync(
      process.execPath,
      [script, "--output", output, ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(output, "utf8"), "unchanged");
    assert.equal(existsSync(output + ".stats.json"), false);
    assert.equal(existsSync(output + ".simulation.json"), false);
  }
  const outDir = join(dir, "directory");
  mkdirSync(outDir);
  const io = spawnSync(
    process.execPath,
    [script, "--customers", "1000", "--days", "30", "--output", outDir],
    { encoding: "utf8" },
  );
  assert.equal(io.status, 1);
  assert.equal(io.stdout, "");
});

test("TC-126-11/12: API options, seed boundaries and hostile CSV characters", () => {
  for (const options of [
    { seed: "" },
    { seed: null },
    { seed: 42 },
    { customers: 999 },
    { days: 29 },
    { days: 91 },
    { customers: 100001 },
  ])
    assert.throws(() => generateFraudDataset(options));
  for (const seed of ["x".repeat(128), "comma,\nformula=1"]) {
    const d = generateFraudDataset({ seed, customers: 1000, days: 30 });
    assert.ok(d.stats.transactions > 0);
    assert.ok(!d.csv.includes(seed));
  }
});

test("TC-126-01/12: identical memory artifacts without wall clock or unseeded randomness", () => {
  const first = generateFraudDataset({ customers: 1000, days: 30 }),
    now = Date.now,
    random = Math.random;
  try {
    Date.now = () => {
      throw new Error("wall clock forbidden");
    };
    Math.random = () => {
      throw new Error("unseeded random forbidden");
    };
    assert.deepEqual(
      generateFraudDataset({ customers: 1000, days: 30 }),
      first,
    );
  } finally {
    Date.now = now;
    Math.random = random;
  }
  const check = spawnSync(
    "git",
    [
      "check-ignore",
      "load-tests/results/fraud-mixed.csv",
      "load-tests/results/fraud-mixed.csv.simulation.json",
      "load-tests/results/fraud-mixed.csv.stats.json",
    ],
    {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
    },
  );
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim().split("\n").length, 3);
});

test("TC-126-12: ignore checks work from the backend CI working directory", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-name-pattern=identical memory",
      fileURLToPath(import.meta.url),
    ],
    {
      encoding: "utf8",
      env: childEnv,
      cwd: fileURLToPath(new URL("../../backend/", import.meta.url)),
    },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /tests 1\b/);
});
