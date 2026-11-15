import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSplitDataset } from "./split.mjs";
import {
  INTRINSIC,
  auditSplit,
  leakage,
  parseCsv,
  profile,
  ruleHits,
  tuneManifestText,
  valueCandidates,
} from "./audit-split.mjs";

const CLI = fileURLToPath(new URL("./audit-split.mjs", import.meta.url));
const HEADER =
  "tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario";
const data = generateSplitDataset();
const report = auditSplit({ data });
const run = (args = [], env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DBS_AUDIT_SEED_FILE: "", ...env },
  });
const temporary = (fn) => {
  const root = mkdtempSync(join(tmpdir(), "dbs146-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// Hand-written fixture: one id per row, timestamps relative to a fixed base.
const BASE = Date.parse("2026-02-01T03:00:00.000Z");
let n = 0;
const id = (k) => {
  const h = createHash("sha256").update(String(k)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const OLD = "2025-01-01T17:00:00.000Z";
function row(from, to, ms, amount, opts = {}) {
  return [
    id(`tx${n++}`),
    new Date(BASE + ms).toISOString(),
    id(`a${from}`),
    id(`a${to}`),
    id(`c${opts.fromCustomer ?? from}`),
    id(`c${opts.toCustomer ?? to}`),
    String(amount),
    String(opts.balance ?? 1_000_000_000),
    opts.fromCreated ?? OLD,
    opts.toCreated ?? OLD,
    opts.fraud ? "1" : "0",
    opts.scenario ?? (opts.fraud ? "VELOCITY_BURST" : "NORMAL"),
  ].join(",");
}
const csvOf = (lines) => {
  const sorted = [...lines].sort((a, b) =>
    a.split(",")[1] < b.split(",")[1]
      ? -1
      : a.split(",")[1] > b.split(",")[1]
        ? 1
        : 0,
  );
  return HEADER + "\n" + sorted.join("\n") + "\n";
};
const hitsOf = (lines) => {
  const rows = parseCsv(csvOf(lines));
  const hits = ruleHits(rows);
  return (txIndex) => hits.get(lines[txIndex].split(",")[0]);
};
const MIN = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;

test("TC-146-01 default split has no leakage", () => {
  assert.equal(report.dod1, "met");
  for (const key of ["A1", "A2", "A3", "A4"])
    assert.equal(report.leakage[key], 0, key);
  assert.equal(report.leakage.A5, true);
  assert.equal(report.leakage.A6, true);
});

test("TC-146-02 a holdout customer's row inside tune is detected", () => {
  const holdoutLine = data.holdout.csv.trimEnd().split("\n")[1];
  const lines = data.tune.csv.trimEnd().split("\n");
  const tampered = [lines[0], holdoutLine, ...lines.slice(1)].join("\n") + "\n";
  const result = leakage({ tuneCsv: tampered, holdout: data.holdout });
  assert.ok(result.A1 > 0 && result.A3 > 0 && result.A4 > 0);
  assert.equal(result.met, false);
});

test("TC-146-03 extra label column or manifest key is rejected", () => {
  const lines = data.tune.csv.trimEnd().split("\n");
  const extra =
    [lines[0] + ",holdout_label", ...lines.slice(1).map((l) => l + ",0")].join(
      "\n",
    ) + "\n";
  assert.equal(leakage({ tuneCsv: extra, holdout: data.holdout }).A5, false);
  const manifest = JSON.parse(tuneManifestText(data.tune));
  const withKey =
    JSON.stringify({ ...manifest, holdoutSeed: "x" }, null, 2) + "\n";
  assert.equal(
    leakage({
      tuneCsv: data.tune.csv,
      holdout: data.holdout,
      tuneManifest: withKey,
      expectedManifest: tuneManifestText(data.tune),
    }).A5,
    false,
  );
  const oneByte = tuneManifestText(data.tune).replace(
    '"version": 1',
    '"version": 2',
  );
  assert.equal(
    leakage({
      tuneCsv: data.tune.csv,
      holdout: data.holdout,
      tuneManifest: oneByte,
      expectedManifest: tuneManifestText(data.tune),
    }).A5,
    false,
  );
});

test("TC-146-04 profile matches generator stats and thresholds", () => {
  const p = report.profile.tune;
  assert.equal(p.transactions, data.tune.stats.transactions);
  assert.equal(p.fraudTransactions, data.tune.stats.fraudTransactions);
  assert.equal(p.amountNormal.p50 !== undefined, true);
  assert.equal(p.activityMean, data.tune.stats.activity.mean);
  assert.ok(report.checks.B1 && report.checks.B2 && report.checks.B3);
  const zero = csvOf([row(1, 2, 0, 0)]);
  assert.equal(
    profile(parseCsv(zero, { allowZero: true })).positiveAmounts,
    false,
  );
});

test("TC-146-05 rule restatements hit at the documented boundaries", () => {
  // R1: sixth transfer inside 10 minutes hits, fifth does not; exactly 10:00 is outside.
  {
    const l = [0, 1, 2, 3, 4, 5].map((i) => row(1, 10 + i, i * MIN, 1000));
    const h = hitsOf(l);
    assert.equal(h(4).R1, false);
    assert.equal(h(5).R1, true);
    const edge = [
      row(1, 10, 0, 1000),
      ...[1, 2, 3, 4, 5].map((i) => row(1, 10 + i, 10 * MIN - 5 + i, 1000)),
    ];
    assert.equal(hitsOf(edge)(5).R1, false); // the first row is exactly 10:00 before the last
    const within = [
      row(1, 10, 1, 1000),
      ...[1, 2, 3, 4, 5].map((i) => row(1, 10 + i, 10 * MIN, 1000)),
    ];
    assert.equal(hitsOf(within)(1).R1, true); // same-timestamp group counts as a whole
  }
  // R2: five history rows needed; exactly 5x median does not hit; +1 dong hits; half-dong median.
  {
    const hist = [100, 100, 100, 100].map((a, i) => row(2, 20, i * HOUR, a));
    assert.equal(hitsOf([...hist, row(2, 20, 10 * HOUR, 10_000)])(4).R2, false);
    const five = [...hist, row(2, 20, 5 * HOUR, 100)];
    assert.equal(hitsOf([...five, row(2, 20, 10 * HOUR, 500)])(5).R2, false);
    assert.equal(hitsOf([...five, row(2, 20, 10 * HOUR, 501)])(5).R2, true);
    const even = [100, 101, 101, 100, 100, 101].map((a, i) =>
      row(3, 30, i * HOUR, a),
    ); // median 100.5
    assert.equal(hitsOf([...even, row(3, 30, 10 * HOUR, 502)])(6).R2, false); // 2*502=1004 < 5*201=1005
    assert.equal(hitsOf([...even, row(3, 30, 10 * HOUR, 503)])(6).R2, true);
    const thirty = [
      row(4, 40, 0, 100),
      ...[1, 2, 3, 4].map((i) => row(4, 40, i * HOUR, 100)),
    ];
    assert.equal(hitsOf([...thirty, row(4, 40, 30 * DAY, 501)])(5).R2, true); // exactly 30 days counts
    assert.equal(
      hitsOf([...thirty, row(4, 40, 30 * DAY + 1, 501)])(5).R2,
      false,
    );
  }
  // R3: age < 24h and amount > 10,000,000.
  {
    const created = new Date(BASE - 24 * HOUR + 1000).toISOString();
    assert.equal(
      hitsOf([row(5, 50, 0, 10_000_001, { fromCreated: created })])(0).R3,
      true,
    );
    assert.equal(
      hitsOf([row(5, 50, 0, 10_000_000, { fromCreated: created })])(0).R3,
      false,
    );
    const day = new Date(BASE - 24 * HOUR).toISOString();
    assert.equal(
      hitsOf([row(5, 50, 0, 10_000_001, { fromCreated: day })])(0).R3,
      false,
    );
    const future = new Date(BASE + HOUR).toISOString();
    assert.equal(
      hitsOf([row(5, 50, 0, 10_000_001, { fromCreated: future })])(0).R3,
      true,
    );
  }
  // R4: reverse transfer at exactly 1:00:00 hits, 1 ms more does not, same timestamp does not.
  {
    assert.equal(
      hitsOf([row(7, 6, 0, 1000), row(6, 7, HOUR, 1000)])(1).R4,
      true,
    );
    assert.equal(
      hitsOf([row(7, 6, 0, 1000), row(6, 7, HOUR + 1, 1000)])(1).R4,
      false,
    );
    assert.equal(
      hitsOf([row(7, 6, 0, 1000), row(6, 7, 59 * MIN + 59_000, 1000)])(1).R4,
      true,
    );
    assert.equal(
      hitsOf([row(7, 6, 5 * MIN, 1000), row(6, 7, 5 * MIN, 1000)])(1).R4,
      false,
    );
  }
  // R5: five new recipients hit, four do not; a recipient paid exactly 30 days earlier is not new.
  {
    const four = [0, 1, 2, 3].map((i) =>
      row(8, 80 + i, 40 * DAY + i * MIN, 1000),
    );
    assert.equal(hitsOf(four)(3).R5, false);
    const five = [...four, row(8, 84, 40 * DAY + 4 * MIN, 1000)];
    assert.equal(hitsOf(five)(4).R5, true);
    const old = [row(8, 84, 10 * DAY + 4 * MIN, 1000), ...five];
    assert.equal(hitsOf(old)(5).R5, false); // 84 was paid exactly 30 days before
    const sameTs = [0, 1, 2, 3].map((i) => row(9, 90 + i, i * MIN, 1000));
    const pair = [
      ...sameTs,
      row(9, 94, 5 * MIN, 1000),
      row(9, 94, 5 * MIN, 1000),
    ];
    assert.equal(hitsOf(pair)(5).R5, true); // both same-timestamp rows to 94 are new
    // The earliest in-window row to 95 leaves the window; the next row to 95 is not new.
    const leave = [
      row(11, 95, 0, 1000),
      row(11, 95, 30 * MIN, 1000),
      ...[0, 1, 2, 3].map((i) => row(11, 96 + i, 61 * MIN + i, 1000)),
    ];
    assert.equal(hitsOf(leave)(5).R5, false); // 95's in-window head was paid 30 min earlier
    const own = [0, 1, 2, 3, 4].map((i) =>
      row(12, 120 + i, i * MIN, 1000, { toCustomer: 12 }),
    );
    assert.equal(hitsOf(own)(4).R5, false);
  }
  // R6: balance >= 1,000,000 and amount >= 90% of balance, not same owner.
  {
    assert.equal(
      hitsOf([row(13, 130, 0, 900_000, { balance: 1_000_000 })])(0).R6,
      true,
    );
    assert.equal(
      hitsOf([row(13, 130, 0, 899_999, { balance: 999_999 })])(0).R6,
      false,
    );
    assert.equal(
      hitsOf([row(13, 130, 0, 899_999, { balance: 1_000_000 })])(0).R6,
      false,
    );
    assert.equal(
      hitsOf([
        row(13, 130, 0, 900_000, { balance: 1_000_000, toCustomer: 13 }),
      ])(0).R6,
      false,
    );
  }
});

test("TC-146-06 value candidates flag concentrated bins and stay quiet on spread data", () => {
  const lines = [];
  for (let i = 0; i < 400; i++)
    lines.push(
      row(200 + (i % 50), 300 + (i % 37), i * HOUR, 1000 + i * 997, {
        toCreated: new Date(Date.parse(OLD) - (i % 300) * DAY).toISOString(),
      }),
    );
  const spread = [...lines];
  for (let i = 0; i < 40; i++)
    spread.push(
      row(500 + i, 600 + i, i * HOUR + 7, 1000 + i * 991, {
        fraud: true,
        toCreated: new Date(Date.parse(OLD) - i * 7 * DAY).toISOString(),
      }),
    );
  const quiet = valueCandidates(parseCsv(csvOf(spread)));
  assert.equal(
    quiet.filter((c) => c.feature === "to_created" && c.kind === "tell").length,
    0,
  );
  const shared = [...lines];
  const tell = "2024-04-04T17:00:00.000Z";
  for (let i = 0; i < 40; i++)
    shared.push(
      row(500 + i, 600 + i, i * HOUR + 7, 1000 + i * 991, {
        fraud: true,
        toCreated: tell,
        scenario: i % 2 ? "VELOCITY_BURST" : "MULE_FANOUT",
      }),
    );
  const found = valueCandidates(parseCsv(csvOf(shared)));
  assert.ok(
    found.some(
      (c) =>
        c.label === "FRAUD" && c.feature === "to_created" && c.kind === "tell",
    ),
  );
  const single = [...lines];
  for (let i = 0; i < 40; i++)
    single.push(
      row(500 + i, 999, i * HOUR + 7, 1000 + i * 991, {
        fraud: true,
        toCreated: tell,
        scenario: "FAN_IN",
      }),
    );
  const lim = valueCandidates(parseCsv(csvOf(single)));
  assert.ok(
    lim.some(
      (c) =>
        c.label === "FAN_IN" &&
        c.feature === "to_created" &&
        c.kind === "limitation",
    ),
  );
});

test("TC-146-07 after the generator fix no tell remains on the default split", () => {
  const tells = report.findings.filter((f) => f.kind === "tell");
  assert.deepEqual(tells, []);
  for (const f of report.findings)
    assert.ok(["intrinsic", "limitation"].includes(f.kind));
  assert.equal(report.accountLevel.length, 0);
  assert.deepEqual(Object.keys(INTRINSIC).sort(), [
    "ATO_DRAIN",
    "BUST_OUT",
    "FAN_IN",
    "MULE_FANOUT",
    "ROUND_TRIP",
    "SLOW_DRIP",
    "STRUCTURING",
    "VELOCITY_BURST",
  ]);
  assert.deepEqual(INTRINSIC.FAN_IN, { features: [], rules: [] });
  assert.deepEqual(INTRINSIC.VELOCITY_BURST.rules, ["R1"]);
});

test("TC-146-08 rule separation of out-of-scope scenarios is never trivial", () => {
  for (const s of ["SLOW_DRIP", "STRUCTURING", "FAN_IN"])
    assert.equal(
      report.ruleMatrix.filter((m) => m.scenario === s && m.separates).length,
      0,
      s,
    );
  for (const m of report.ruleMatrix.filter(
    (x) => x.separates && x.kind === "intrinsic",
  ))
    assert.ok(INTRINSIC[m.scenario].rules.includes(m.rule));
});

// Golden taken on the generator before the DBS-146 fix, with both account-created columns removed.
const GOLDEN_WITHOUT_CREATED =
  "ad058b46121d4a5a1c38e8580eaa5fa6afff6281da2b9c782cf81b6bce5e30f4";
test("TC-146-09 the generator fix only changes account-created columns", () => {
  const stripped = data.tune.csv
    .trimEnd()
    .split("\n")
    .map((l) => {
      const c = l.split(",");
      c.splice(8, 2);
      return c.join(",");
    })
    .join("\n");
  assert.equal(
    createHash("sha256").update(stripped).digest("hex"),
    GOLDEN_WITHOUT_CREATED,
  );
});

test("TC-146-10 CLI prints one aggregate JSON line and rejects bad arguments", () => {
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.dod1, "met");
  for (const c of data.holdout.simulation.customers.slice(0, 50))
    assert.ok(!ok.stdout.includes(c.customerId));
  for (const args of [
    ["--seed", "x"],
    ["--customers", "100"],
    ["--days", "99"],
    ["--bogus", "1"],
    ["--days", "30", "--days", "31"],
  ]) {
    const bad = run(args);
    assert.equal(bad.status, 1, args.join(" "));
    assert.equal(bad.stdout, "");
    for (const a of args)
      if (a.length > 2 && !a.startsWith("--"))
        assert.ok(!bad.stderr.includes(a));
  }
  temporary((root) => {
    const file = (name, body) => {
      const p = join(root, name);
      writeFileSync(p, body);
      return p;
    };
    for (const body of [
      "",
      "\n\n",
      "dbs-split-v1\n\n",
      "﻿dbs-split-v1",
      " dbs-split-v1",
      "dbs\u0001split",
      "x".repeat(129),
    ]) {
      const r = run([], {
        DBS_AUDIT_SEED_FILE: file("s" + Math.random(), body),
      });
      assert.equal(r.status, 1, JSON.stringify(body));
    }
    assert.equal(
      run([], { DBS_AUDIT_SEED_FILE: join(root, "missing") }).status,
      1,
    );
    for (const body of ["dbs-split-v1\n", "dbs-split-v1\r\n"]) {
      const r = run([], {
        DBS_AUDIT_SEED_FILE: file("ok" + Math.random(), body),
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, ok.stdout);
    }
  });
});

test("TC-146-11 output is deterministic and delivered files are checked byte for byte", () =>
  temporary((root) => {
    const csv = join(root, "tune.csv"),
      manifest = join(root, "manifest.json");
    writeFileSync(csv, data.tune.csv);
    writeFileSync(manifest, tuneManifestText(data.tune));
    const a = run(["--tune-csv", csv, "--tune-manifest", manifest]);
    const b = run(["--tune-csv", csv, "--tune-manifest", manifest]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, b.stdout);
    writeFileSync(csv, data.tune.csv.replace(/,0,NORMAL\n/, ",1,NORMAL\n"));
    assert.equal(run(["--tune-csv", csv]).status, 1);
    writeFileSync(csv, data.tune.csv);
    writeFileSync(
      manifest,
      tuneManifestText(data.tune).replace('"version"', '"versio"'),
    );
    assert.equal(
      run(["--tune-csv", csv, "--tune-manifest", manifest]).status,
      1,
    );
  }));

test("TC-146-13 holdout coverage: missing scenario volume fails, thin HN is reported", () => {
  const cut =
    data.holdout.csv
      .trimEnd()
      .split("\n")
      .filter((l, i) => i === 0 || !l.endsWith(",SLOW_DRIP"))
      .join("\n") + "\n";
  const r = auditSplit({
    data: { tune: data.tune, holdout: { ...data.holdout, csv: cut } },
  });
  assert.equal(r.checks.B5, false);
  assert.equal(r.exitCode, 1);
  assert.equal(report.holdoutHn, "thin");
  assert.equal(report.exitCode, 0);
});

test("TC-146-14 hits-out writes one row per tune transaction and refuses unsafe paths", () =>
  temporary((root) => {
    const out = join(root, "hits.csv");
    const r = run(["--hits-out", out]);
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(out, "utf8").trimEnd().split("\n");
    assert.equal(lines[0], "tx_id,R1,R2,R3,R4,R5,R6");
    assert.equal(lines.length - 1, data.tune.stats.transactions);
    assert.equal(run(["--hits-out", out]).status, 1); // already exists
    const inRepo = fileURLToPath(
      new URL("./hits-should-not-exist.csv", import.meta.url),
    );
    assert.equal(run(["--hits-out", inRepo]).status, 1);
    assert.equal(existsSync(inRepo), false);
    const link = join(root, "repo-link");
    try {
      symlinkSync(
        fileURLToPath(new URL(".", import.meta.url)),
        link,
        "junction",
      );
      const via = join(link, "hits-via-link.csv");
      assert.equal(run(["--hits-out", via]).status, 1);
      assert.equal(
        existsSync(
          fileURLToPath(new URL("./hits-via-link.csv", import.meta.url)),
        ),
        false,
      );
    } catch (error) {
      if (error.code !== "EPERM") throw error;
    }
  }));
