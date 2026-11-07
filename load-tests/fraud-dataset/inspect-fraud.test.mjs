import assert from "node:assert/strict";
import test from "node:test";
import { inspectDataset } from "./inspect-fraud.mjs";
import { generateDataset, COLUMNS } from "./generate.mjs";

const id = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const old = "2025-01-01T00:00:00.000Z";
const start = "2025-12-31T17:00:00.000Z";
const midnight = "2026-01-01T17:00:00.000Z";
const big = 9007199254740993n;
function fixture() {
  const accounts = [
    {
      accountId: id(1),
      customerId: id(11),
      createdAt: old,
      openingBalance: String(big),
      endingBalance: "5",
    },
    {
      accountId: id(2),
      customerId: id(12),
      createdAt: old,
      openingBalance: "0",
      endingBalance: String(big + 45n),
    },
    {
      accountId: id(3),
      customerId: id(13),
      createdAt: midnight,
      openingBalance: "0",
      endingBalance: "50",
    },
  ];
  const simulation = {
    version: 1,
    seed: "fixture",
    days: 2,
    startAt: start,
    endAt: "2026-01-02T17:00:00.000Z",
    customers: accounts.map((a) => ({
      customerId: a.customerId,
      createdAt: a.createdAt,
    })),
    accounts,
    initialFundingBalance: String(-big),
    endingFundingBalance: String(-big - 100n),
    credits: [
      {
        accountId: id(3),
        occurredAt: midnight,
        amount: "100",
        kind: "salary",
        sequence: 0,
      },
    ],
  };
  const rows = [
    [
      id(21),
      "2026-01-01T16:59:59.000Z",
      id(1),
      id(2),
      id(11),
      id(12),
      String(big - 3n),
      String(big),
      old,
      old,
      "0",
      "NORMAL",
    ],
    [
      id(22),
      midnight,
      id(2),
      id(1),
      id(12),
      id(11),
      "2",
      String(big - 3n),
      old,
      old,
      "0",
      "HN_BORROW_REPAY",
    ],
    [
      id(23),
      "2026-01-01T17:00:01.000Z",
      id(3),
      id(2),
      id(13),
      id(12),
      "50",
      "100",
      midnight,
      old,
      "1",
      "BUST_OUT",
    ],
  ];
  return { simulation, rows };
}
const csv = (rows) =>
  [COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";

test("TC-126-06/07/08/09: hand-calculated replay, precise money, Vietnamese midnight and zero days", () => {
  const f = fixture();
  const r = inspectDataset(csv(f.rows), f.simulation);
  assert.equal(r.transactions, 3);
  assert.equal(r.fraudTransactions, 1);
  assert.equal(r.fraudRate, 1 / 3);
  assert.deepEqual(r.scenarioCounts, {
    NORMAL: 1,
    HN_BORROW_REPAY: 1,
    BUST_OUT: 1,
  });
  assert.deepEqual(r.amount, {
    min: "2",
    p50: "50",
    p90: "50",
    p99: "50",
    max: String(big - 3n),
  });
  assert.deepEqual(r.activity, {
    customers: 3,
    days: 2,
    customerDays: 6,
    mean: 0.5,
    p50: 0,
    p90: 1,
    max: 1,
  });
  assert.equal(r.totalDebits, String(big + 49n));
  assert.equal(r.totalCredits, r.totalDebits);
  assert.equal(r.endingCustomerBalances, String(big + 100n));
  assert.equal(r.fundingBalance, String(-big - 100n));
});

test("TC-126-08: multiple accounts count under one customer, including inactive customers", () => {
  const f = fixture();
  f.simulation.accounts[1].customerId = id(11);
  f.simulation.customers.splice(1, 1);
  f.rows[0][5] = id(11);
  f.rows[1][4] = id(11);
  f.rows[2][5] = id(11);
  f.rows.push([
    id(24),
    "2026-01-01T17:00:02.000Z",
    id(1),
    id(3),
    id(11),
    id(13),
    "1",
    "5",
    old,
    midnight,
    "0",
    "NORMAL",
  ]);
  f.simulation.accounts[0].endingBalance = "4";
  f.simulation.accounts[2].endingBalance = "51";
  const r = inspectDataset(csv(f.rows), f.simulation);
  assert.deepEqual(r.activity, {
    customers: 2,
    days: 2,
    customerDays: 4,
    mean: 1,
    p50: 1,
    p90: 1,
    max: 2,
  });
});

test("TC-126-07: inspect the existing NORMAL trace independently", () => {
  const d = generateDataset({ customers: 30, days: 4 });
  const r = inspectDataset(d.csv, d.simulation);
  assert.equal(r.transactions, d.stats.transactions);
  assert.equal(r.totalDebits, String(d.stats.totalDebits));
});

const mutations = {
  "missing column": (f) => f.rows[0].pop(),
  "duplicate tx": (f) => {
    f.rows[1][0] = f.rows[0][0];
  },
  "unknown account": (f) => {
    f.rows[0][2] = id(99);
  },
  "wrong owner": (f) => {
    f.rows[0][4] = id(12);
  },
  "self account": (f) => {
    f.rows[0][3] = f.rows[0][2];
  },
  "invalid date": (f) => {
    f.rows[0][1] = "not-a-date";
  },
  "noncanonical date": (f) => {
    f.rows[0][1] = "2026-01-01T16:59:59Z";
  },
  "time goes backwards": (f) => f.rows.reverse(),
  "out of period": (f) => {
    f.rows[2][1] = f.simulation.endAt;
  },
  "negative amount": (f) => {
    f.rows[0][6] = "-1";
  },
  "exponent amount": (f) => {
    f.rows[0][6] = "1e3";
  },
  "leading zero": (f) => {
    f.rows[1][6] = "02";
  },
  "bad snapshot": (f) => {
    f.rows[0][7] = String(big - 1n);
  },
  "missing credit": (f) => {
    f.simulation.credits = [];
  },
  "credit before opening": (f) => {
    f.simulation.credits[0].occurredAt = start;
  },
  "duplicate credit sequence": (f) => {
    f.simulation.credits.push({ ...f.simulation.credits[0] });
  },
  "credit outside period": (f) => {
    f.simulation.credits[0].occurredAt = f.simulation.endAt;
  },
  "unknown credit account": (f) => {
    f.simulation.credits[0].accountId = id(99);
  },
  "negative credit": (f) => {
    f.simulation.credits[0].amount = "-1";
  },
  "new account with opening balance": (f) => {
    f.simulation.accounts[2].openingBalance = "1";
  },
  "wrong ending balance": (f) => {
    f.simulation.accounts[1].endingBalance = "0";
  },
  "wrong initial funding": (f) => {
    f.simulation.initialFundingBalance = "0";
  },
  "wrong final funding": (f) => {
    f.simulation.endingFundingBalance = "0";
  },
  "invalid fraud label": (f) => {
    f.rows[0][10] = "true";
  },
  "scenario label mismatch": (f) => {
    f.rows[0][11] = "ATO_DRAIN";
  },
  "unknown scenario": (f) => {
    f.rows[0][11] = "OTHER";
  },
  "wrong account created snapshot": (f) => {
    f.rows[0][8] = start;
  },
  "transfer at opening": (f) => {
    f.rows[2][1] = midnight;
  },
  "duplicate registry id": (f) => {
    f.simulation.accounts.push({ ...f.simulation.accounts[0] });
  },
  "missing customer": (f) => {
    f.simulation.customers.pop();
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`TC-126-06/07: reject ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspectDataset(csv(f.rows), f.simulation));
  });
}
