import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, generateSplitDataset, insideCheckout } from "./split.mjs";

// DBS-146: audit a tune/holdout split for leakage and trivial label signals.
// Holdout stays in memory; stdout carries aggregates only (no IDs, no per-row labels, no paths).

const HEADER =
  "tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario";
const COLUMNS = HEADER.split(",");
const MANIFEST_KEYS = [
  "version",
  "columns",
  "sha256",
  "customers",
  "transactions",
];
export const FRAUD = [
  "ATO_DRAIN",
  "MULE_FANOUT",
  "VELOCITY_BURST",
  "BUST_OUT",
  "ROUND_TRIP",
  "SLOW_DRIP",
  "STRUCTURING",
  "FAN_IN",
];
const HN = [
  "HN_RENT",
  "HN_SELF_TRANSFER",
  "HN_NEW_SALARY",
  "HN_GROUP_MEAL",
  "HN_BORROW_REPAY",
];
const RULES = ["R1", "R2", "R3", "R4", "R5", "R6"];
const MIN = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;

/** Fixed before the first run (AUDIT-NOTES.md): pairs explained by the public one-line description. */
export const INTRINSIC = Object.freeze({
  ATO_DRAIN: { features: ["drain_decile"], rules: ["R6", "R5", "R1"] },
  MULE_FANOUT: { features: [], rules: ["R5", "R1"] },
  VELOCITY_BURST: { features: ["amount_log", "amount_window"], rules: ["R1"] },
  BUST_OUT: {
    features: [
      "age_bucket",
      "from_created",
      "from_created_hour",
      "from_created_b30",
      "drain_decile",
      "amount_log",
      "amount_window",
    ],
    rules: ["R3", "R6"],
  },
  ROUND_TRIP: { features: [], rules: ["R4"] },
  SLOW_DRIP: { features: ["amount_log", "amount_window"], rules: [] },
  STRUCTURING: { features: ["amount_log", "amount_window"], rules: [] },
  FAN_IN: { features: [], rules: [] },
});

const digest = (s) => createHash("sha256").update(s).digest("hex");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const quantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];

export function parseCsv(csv, { allowZero = false } = {}) {
  if (typeof csv !== "string" || !csv.endsWith("\n")) throw new Error("csv");
  const [header, ...lines] = csv.trimEnd().split("\n");
  if (header !== HEADER) throw new Error("header");
  return lines.map((line, index) => {
    const c = line.split(",");
    if (c.length !== 12) throw new Error("row");
    const amount = BigInt(c[6]);
    if (!allowZero && amount <= 0n) throw new Error("amount");
    return {
      index,
      tx: c[0],
      t: Date.parse(c[1]),
      from: c[2],
      to: c[3],
      fromCustomer: c[4],
      toCustomer: c[5],
      amount,
      balance: BigInt(c[7]),
      fromCreated: c[8],
      toCreated: c[9],
      fraud: c[10] === "1",
      label: c[10],
      scenario: c[11],
    };
  });
}

export function tuneManifestText(part) {
  return (
    JSON.stringify(
      {
        version: 1,
        columns: COLUMNS,
        sha256: digest(part.csv),
        customers: part.simulation.customers.length,
        transactions: part.stats.transactions,
      },
      null,
      2,
    ) + "\n"
  );
}

/** DoD 1: A1–A6. holdout = { csv, simulation }. */
export function leakage({ tuneCsv, holdout, tuneManifest, expectedManifest }) {
  const headerOk = tuneCsv.split("\n", 1)[0] === HEADER;
  let rows = [];
  try {
    rows = parseCsv(tuneCsv, { allowZero: true });
  } catch {
    rows = null;
  }
  const holdCustomers = new Set(
    holdout.simulation.customers.map((c) => c.customerId),
  );
  const holdAccounts = new Set(
    holdout.simulation.accounts.map((a) => a.accountId),
  );
  const holdRows = parseCsv(holdout.csv, { allowZero: true });
  const holdTx = new Set(holdRows.map((r) => r.tx));
  const result = {
    A1: 0,
    A2: 0,
    A3: 0,
    A4: 0,
    A5: headerOk && rows !== null,
    A6: true,
  };
  const tuneCustomers = new Set(),
    tuneAccounts = new Set();
  // Rows are re-read without the header check so leakage is still counted on a malformed file.
  const body = tuneCsv
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","));
  for (const c of body) {
    tuneCustomers.add(c[4]);
    tuneCustomers.add(c[5]);
    tuneAccounts.add(c[2]);
    tuneAccounts.add(c[3]);
    if (holdTx.has(c[0])) result.A2++;
    if (
      holdCustomers.has(c[4]) ||
      holdCustomers.has(c[5]) ||
      holdAccounts.has(c[2]) ||
      holdAccounts.has(c[3])
    )
      result.A3++;
    const fraud = FRAUD.includes(c[11]);
    if (
      c.length !== 12 ||
      !(
        (c[10] === "1" && fraud) ||
        (c[10] === "0" && (c[11] === "NORMAL" || HN.includes(c[11])))
      )
    )
      result.A6 = false;
  }
  for (const c of tuneCustomers) if (holdCustomers.has(c)) result.A1++;
  for (const a of tuneAccounts) if (holdAccounts.has(a)) result.A2++;
  // A4: every UUID-shaped substring anywhere in the bytes, not only whole fields.
  const scan = (text) => {
    const found = new Set(
      text.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      ) ?? [],
    );
    let hits = 0;
    for (const set of [holdCustomers, holdAccounts, holdTx])
      for (const v of set) if (found.has(v)) hits++;
    return hits;
  };
  result.A4 = scan(tuneCsv) + (tuneManifest ? scan(tuneManifest) : 0);
  if (tuneManifest !== undefined) {
    let keysOk = false;
    try {
      keysOk =
        JSON.stringify(Object.keys(JSON.parse(tuneManifest))) ===
        JSON.stringify(MANIFEST_KEYS);
    } catch {
      keysOk = false;
    }
    result.A5 = result.A5 && keysOk && tuneManifest === expectedManifest;
  }
  result.met =
    result.A1 === 0 &&
    result.A2 === 0 &&
    result.A3 === 0 &&
    result.A4 === 0 &&
    result.A5 &&
    result.A6;
  return result;
}

/** B1–B4 on one part. */
export function profile(rows, { registryCustomers, days } = {}) {
  const scenarioCounts = {};
  for (const r of rows)
    scenarioCounts[r.scenario] = (scenarioCounts[r.scenario] ?? 0) + 1;
  const fraudTransactions = rows.filter((r) => r.fraud).length;
  const normal = rows
    .filter((r) => r.scenario === "NORMAL")
    .map((r) => r.amount)
    .sort(cmp);
  const amounts = (list) => {
    const s = list.map((r) => r.amount).sort(cmp);
    return {
      p50: String(quantile(s, 0.5)),
      p90: String(quantile(s, 0.9)),
      p99: String(quantile(s, 0.99)),
      max: String(s.at(-1)),
    };
  };
  const byScenario = {};
  for (const s of [...FRAUD, ...HN]) {
    const list = rows.filter((r) => r.scenario === s);
    byScenario[s] = list.length
      ? { rows: list.length, ...amounts(list) }
      : { rows: 0 };
  }
  return {
    transactions: rows.length,
    fraudTransactions,
    fraudRate: rows.length ? fraudTransactions / rows.length : 0,
    scenarioCounts,
    positiveAmounts: rows.every((r) => r.amount > 0n),
    amountNormal: normal.length
      ? {
          p50: String(quantile(normal, 0.5)),
          p90: String(quantile(normal, 0.9)),
          p99: String(quantile(normal, 0.99)),
          max: String(normal.at(-1)),
        }
      : {},
    byScenario,
    activityMean:
      registryCustomers && days
        ? rows.length / (registryCustomers * days)
        : undefined,
  };
}

const lowerBound = (arr, x) => {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Independent restatement of R1–R6 v1 (FRAUD guide §4.2, OfflineFeatureProvider windows). */
export function ruleHits(rows) {
  const byFrom = new Map(),
    pairTimes = new Map();
  for (const r of rows) {
    if (!byFrom.has(r.from)) byFrom.set(r.from, []);
    byFrom.get(r.from).push(r);
    const key = r.from + ">" + r.to;
    if (!pairTimes.has(key)) pairTimes.set(key, []);
    pairTimes.get(key).push(r.t);
  }
  for (const list of byFrom.values())
    list.sort((a, b) => a.t - b.t || a.index - b.index);
  for (const times of pairTimes.values()) times.sort((a, b) => a - b);
  const hits = new Map();
  for (const list of byFrom.values()) {
    const times = list.map((r) => r.t);
    for (const r of list) {
      const t = r.t;
      const sameOwner = r.fromCustomer === r.toCustomer;
      const end = lowerBound(times, t + 1); // rows at or before t, the same-timestamp group included
      // R1: (t − 10 min, t]
      const r1 = end - lowerBound(times, t - 10 * MIN + 1) > 5;
      // R2: history [t − 30 d, t)
      const hStart = lowerBound(times, t - 30 * DAY),
        hEnd = lowerBound(times, t);
      let r2 = false;
      if (hEnd - hStart >= 5) {
        const h = list
          .slice(hStart, hEnd)
          .map((x) => x.amount)
          .sort(cmp);
        const n = h.length;
        const m2 = n % 2 ? 2n * h[(n - 1) / 2] : h[n / 2 - 1] + h[n / 2];
        r2 = 2n * r.amount > 5n * m2;
      }
      // R3
      const age = Math.max(0, t - Date.parse(r.fromCreated));
      const r3 = age < 24 * HOUR && r.amount > 10_000_000n;
      // R4: reverse transfer in [t − 1 h, t)
      const rev = pairTimes.get(r.to + ">" + r.from) ?? [];
      const before = lowerBound(rev, t) - 1;
      const r4 = before >= 0 && rev[before] >= t - HOUR;
      // R5: window (t − 1 h, t]; newness judged at each recipient's earliest in-window row τ against [τ − 30 d, τ)
      let r5 = false;
      if (!sameOwner) {
        const wStart = lowerBound(times, t - HOUR + 1);
        const heads = new Map();
        for (let i = wStart; i < end; i++)
          if (!heads.has(list[i].to)) heads.set(list[i].to, list[i].t);
        let fresh = 0;
        for (const [to, tau] of heads) {
          const pt = pairTimes.get(r.from + ">" + to);
          const j = lowerBound(pt, tau) - 1;
          if (j < 0 || pt[j] < tau - 30 * DAY) fresh++;
        }
        r5 = fresh >= 5;
      }
      // R6
      const r6 =
        !sameOwner &&
        r.balance >= 1_000_000n &&
        r.amount * 10n >= r.balance * 9n;
      hits.set(r.tx, { R1: r1, R2: r2, R3: r3, R4: r4, R5: r5, R6: r6 });
    }
  }
  return hits;
}

/** C1: per scenario × rule recall by row, source and pair, and false-positive rate on non-fraud rows. */
export function ruleMatrix(rows, hits) {
  const nonFraud = rows.filter((r) => !r.fraud);
  const out = [];
  for (const s of FRAUD) {
    const list = rows.filter((r) => r.scenario === s);
    if (!list.length) continue;
    for (const rule of RULES) {
      const hit = (r) => hits.get(r.tx)[rule];
      const srcs = new Map(),
        pairs = new Map();
      for (const r of list) {
        srcs.set(r.from, (srcs.get(r.from) ?? false) || hit(r));
        const key = r.from < r.to ? r.from + r.to : r.to + r.from;
        pairs.set(key, (pairs.get(key) ?? false) || hit(r));
      }
      const share = (m) => [...m.values()].filter(Boolean).length / m.size;
      const recallRow = list.filter(hit).length / list.length;
      const recallSrc = share(srcs),
        recallPair = share(pairs);
      const fpr = nonFraud.filter(hit).length / nonFraud.length;
      const separates =
        Math.max(recallRow, recallSrc, recallPair) >= 0.95 && fpr <= 0.01;
      out.push({
        scenario: s,
        rule,
        recallRow: +recallRow.toFixed(4),
        recallSrc: +recallSrc.toFixed(4),
        recallPair: +recallPair.toFixed(4),
        fpr: +fpr.toFixed(5),
        separates,
        kind: separates
          ? INTRINSIC[s].rules.includes(rule)
            ? "intrinsic"
            : "tell"
          : null,
      });
    }
  }
  return out;
}

const vnHour = (t) => new Date(t + 7 * HOUR).getUTCHours();
const dayIndex = (iso) => Math.floor(Date.parse(iso) / DAY);
const ageBucket = (r) => {
  const a = Math.max(0, r.t - Date.parse(r.fromCreated));
  return a < HOUR
    ? "<1h"
    : a < DAY
      ? "<24h"
      : a < 7 * DAY
        ? "<7d"
        : a < 30 * DAY
          ? "<30d"
          : a < 180 * DAY
            ? "<180d"
            : ">=180d";
};
const FEATURES = {
  from_created: (r) => r.fromCreated,
  to_created: (r) => r.toCreated,
  from_created_hour: (r) => new Date(r.fromCreated).getUTCHours(),
  to_created_hour: (r) => new Date(r.toCreated).getUTCHours(),
  from_created_b30: (r) => Math.floor(dayIndex(r.fromCreated) / 30),
  to_created_b30: (r) => Math.floor(dayIndex(r.toCreated) / 30),
  amount_log: (r) => Math.floor(4 * Math.log10(Number(r.amount))),
  hour_vn: (r) => vnHour(r.t),
  age_bucket: ageBucket,
  drain_decile: (r) =>
    r.balance > 0n ? Math.min(9, Number((r.amount * 10n) / r.balance)) : "none",
  same_owner: (r) => r.fromCustomer === r.toCustomer,
};

function classify(label, feature, inBin) {
  if (label !== "FRAUD" && INTRINSIC[label]?.features.includes(feature))
    return "intrinsic";
  if (new Set(inBin.map((r) => r.to)).size === 1) return "limitation";
  return "tell";
}

/** C2: bins that reveal a label (per scenario and for all fraud). */
export function valueCandidates(rows) {
  const total = rows.length;
  const labels = [
    ...FRAUD.filter((s) => rows.some((r) => r.scenario === s)),
    "FRAUD",
  ];
  const inLabel = (label) =>
    label === "FRAUD" ? (r) => r.fraud : (r) => r.scenario === label;
  const found = [];
  const sortedAmounts = rows.map((r) => r.amount).sort(cmp);
  const cache = Object.fromEntries(
    Object.entries(FEATURES).map(([k, f]) => {
      const arr = [];
      for (const r of rows) arr[r.index] = f(r);
      return [k, arr];
    }),
  );
  for (const label of labels) {
    const is = inLabel(label);
    const S = rows.filter(is);
    if (!S.length) continue;
    const base = S.length / total;
    // eslint-disable-next-line no-unused-vars
    const consider = (feature, _bin, inBin, binTotal, outside = false) => {
      const coverage = inBin.length / S.length;
      const precision = binTotal ? inBin.length / binTotal : 0;
      const lift = precision / base;
      const ok = outside
        ? coverage >= 0.5
        : coverage >= 0.5 &&
          inBin.length >= 20 &&
          lift >= 10 &&
          precision >= 0.1;
      if (ok)
        found.push({
          label,
          feature,
          bin: outside ? "outside-normal" : "value",
          coverage: +coverage.toFixed(4),
          precision: +precision.toFixed(4),
          lift: +lift.toFixed(2),
          kind: classify(label, feature, inBin),
        });
    };
    for (const [feature, vals] of Object.entries(cache)) {
      const all = new Map(),
        normal = new Set(),
        mine = new Map();
      for (const r of rows) {
        const v = vals[r.index];
        all.set(v, (all.get(v) ?? 0) + 1);
        if (r.scenario === "NORMAL") normal.add(v);
        if (is(r)) {
          if (!mine.has(v)) mine.set(v, []);
          mine.get(v).push(r);
        }
      }
      for (const [v, list] of mine) consider(feature, v, list, all.get(v));
      const outside = [...mine.entries()]
        .filter(([v]) => !normal.has(v))
        .flatMap(([, l]) => l);
      if (outside.length)
        consider(feature, "outside", outside, outside.length, true);
    }
    // Narrowest amount interval holding half of S.
    const a = S.map((r) => r.amount).sort(cmp);
    const k = Math.ceil(a.length / 2);
    let lo = 0;
    for (let i = 1; i + k - 1 < a.length; i++)
      if (a[i + k - 1] - a[i] < a[lo + k - 1] - a[lo]) lo = i;
    const [from, to] = [a[lo], a[lo + k - 1]];
    const inWindow = S.filter((r) => r.amount >= from && r.amount <= to);
    const binTotal =
      lowerBound(sortedAmounts, to + 1n) - lowerBound(sortedAmounts, from);
    consider("amount_window", null, inWindow, binTotal);
  }
  return found;
}

/** C3: a scenario whose rows mostly go to one destination account (simulation limitation). */
function concentration(rows) {
  const out = [];
  for (const s of FRAUD) {
    const list = rows.filter((r) => r.scenario === s);
    if (!list.length) continue;
    const per = new Map();
    for (const r of list) per.set(r.to, (per.get(r.to) ?? 0) + 1);
    const top = Math.max(...per.values()) / list.length;
    if (top >= 0.5)
      out.push({
        label: s,
        feature: "C3",
        share: +top.toFixed(4),
        kind: "limitation",
      });
  }
  return out;
}

/** Fallback: account attributes compared per account between fraud-touching and other accounts. */
function accountLevel(rows) {
  const created = new Map(),
    fraudAcc = new Set();
  for (const r of rows) {
    created.set(r.from, r.fromCreated);
    created.set(r.to, r.toCreated);
    if (r.fraud) {
      fraudAcc.add(r.from);
      fraudAcc.add(r.to);
    }
  }
  const countIn = (pred) => {
    const m = new Map();
    let n = 0;
    for (const [acc, v] of created)
      if (pred(acc)) {
        n++;
        m.set(v, (m.get(v) ?? 0) + 1);
      }
    return { m, n };
  };
  const A = countIn((a) => fraudAcc.has(a)),
    B = countIn((a) => !fraudAcc.has(a));
  const out = [];
  for (const [v, c] of A.m)
    if (c / A.n >= 0.5 && (B.m.get(v) ?? 0) / B.n < 0.01)
      out.push({
        label: "FRAUD",
        feature: "account_created",
        share: +(c / A.n).toFixed(4),
        kind: "tell",
      });
  return out;
}

export function auditSplit({ data, tuneCsv, tuneManifest, days = 60 }) {
  const csv = tuneCsv ?? data.tune.csv;
  const expectedManifest = tuneManifestText(data.tune);
  const leak = leakage({
    tuneCsv: csv,
    holdout: data.holdout,
    tuneManifest,
    expectedManifest,
  });
  const sameAsRegenerated = digest(csv) === data.tune.stats.sha256;
  const rows = parseCsv(csv, { allowZero: true });
  const holdRows = parseCsv(data.holdout.csv, { allowZero: true });
  const tune = profile(rows, {
    registryCustomers: data.tune.simulation.customers.length,
    days,
  });
  const hold = profile(holdRows);
  const checks = {
    tuneMatchesRegenerated: sameAsRegenerated,
    B1:
      tune.fraudRate >= 0.008 &&
      tune.fraudRate <= 0.012 &&
      hold.fraudRate >= 0.008 &&
      hold.fraudRate <= 0.012 &&
      FRAUD.every((s) => (tune.scenarioCounts[s] ?? 0) >= 30),
    B2:
      tune.positiveAmounts &&
      BigInt(tune.amountNormal.p50 ?? -1) >= 100_000n &&
      BigInt(tune.amountNormal.p50 ?? -1) <= 5_000_000n,
    B3:
      tune.activityMean >= 0.3 &&
      tune.activityMean <= 3 &&
      tune.activityMean === data.tune.stats.activity.mean,
    B5: FRAUD.every((s) => (hold.scenarioCounts[s] ?? 0) >= 30),
  };
  const holdoutHn = HN.every((s) => (hold.scenarioCounts[s] ?? 0) >= 30)
    ? "ok"
    : "thin";
  const hits = ruleHits(rows);
  const matrix = ruleMatrix(rows, hits);
  const candidates = [...valueCandidates(rows), ...concentration(rows)];
  const accounts = accountLevel(rows);
  const findings = [
    ...matrix
      .filter((m) => m.separates)
      .map((m) => ({ label: m.scenario, feature: m.rule, kind: m.kind })),
    ...candidates,
    ...accounts,
  ];
  const mandatory = leak.met && Object.values(checks).every(Boolean);
  const dod2 =
    checks.B1 &&
    checks.B2 &&
    checks.B3 &&
    checks.B5 &&
    !findings.some((f) => f.kind !== "intrinsic")
      ? "met"
      : "partial";
  return {
    dod1: leak.met ? "met" : "failed",
    dod2,
    exitCode: mandatory ? 0 : 1,
    leakage: {
      A1: leak.A1,
      A2: leak.A2,
      A3: leak.A3,
      A4: leak.A4,
      A5: leak.A5,
      A6: leak.A6,
    },
    checks,
    holdoutHn,
    profile: {
      tune,
      holdout: {
        transactions: hold.transactions,
        fraudRate: hold.fraudRate,
        customers: data.holdout.simulation.customers.length,
      },
    },
    ruleMatrix: matrix,
    findings,
    accountLevel: accounts,
    dod2Notes: findings
      .filter((f) => f.kind === "intrinsic")
      .map((f) => `${f.label}:${f.feature}`),
    counts: {
      intrinsic: findings.filter((f) => f.kind === "intrinsic").length,
      limitation: findings.filter((f) => f.kind === "limitation").length,
      tell: findings.filter((f) => f.kind === "tell").length,
    },
    hits,
  };
}

function readSeed(path) {
  const raw = readFileSync(path, "utf8");
  if (raw.startsWith("﻿")) throw new Error();
  const seed = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : raw;
  if (
    !seed ||
    seed.length > 128 ||
    /[\p{Cc}\p{Cf}]/u.test(seed) ||
    seed.trim() !== seed
  )
    throw new Error();
  return seed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let report;
  try {
    const args = process.argv.slice(2),
      opts = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.startsWith("--") ? args[i].slice(2) : "";
      if (
        ![
          "customers",
          "days",
          "tune-csv",
          "tune-manifest",
          "hits-out",
        ].includes(key) ||
        key in opts ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw new Error();
      opts[key] = args[i + 1];
    }
    const params = {};
    for (const key of ["customers", "days"])
      if (key in opts) {
        if (!/^\d+$/.test(opts[key])) throw new Error();
        params[key] = Number(opts[key]);
      }
    if (process.env.DBS_AUDIT_SEED_FILE)
      params.seed = readSeed(process.env.DBS_AUDIT_SEED_FILE);
    let hitsPath;
    if (opts["hits-out"]) {
      hitsPath = canonical(opts["hits-out"]);
      if (existsSync(hitsPath) || insideCheckout(hitsPath)) throw new Error();
    }
    const data = generateSplitDataset(params);
    report = auditSplit({
      data,
      days: params.days ?? 60,
      tuneCsv: opts["tune-csv"]
        ? readFileSync(opts["tune-csv"], "utf8")
        : undefined,
      tuneManifest: opts["tune-manifest"]
        ? readFileSync(opts["tune-manifest"], "utf8")
        : undefined,
    });
    if (hitsPath && report.exitCode === 0) {
      const lines = ["tx_id," + RULES.join(",")];
      for (const [tx, h] of report.hits)
        lines.push(tx + "," + RULES.map((r) => (h[r] ? 1 : 0)).join(","));
      writeFileSync(hitsPath, lines.join("\n") + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
  } catch {
    process.stderr.write(
      "Audit failed: check arguments, seed file and output path.\n",
    );
    process.exitCode = 1;
  }
  if (report) {
    const { hits, ...printable } = report;
    process.stdout.write(JSON.stringify(printable) + "\n");
    process.exitCode = report.exitCode;
  }
}
