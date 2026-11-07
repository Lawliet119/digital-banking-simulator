import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Kept independent of generator/planner: this is the CSV interchange contract.
const HEADER =
  "tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario";
const FRAUD = new Set([
  "ATO_DRAIN",
  "MULE_FANOUT",
  "VELOCITY_BURST",
  "BUST_OUT",
  "ROUND_TRIP",
  "SLOW_DRIP",
  "STRUCTURING",
  "FAN_IN",
]);
const LEGIT = new Set([
  "NORMAL",
  "HN_RENT",
  "HN_SELF_TRANSFER",
  "HN_NEW_SALARY",
  "HN_GROUP_MEAL",
  "HN_BORROW_REPAY",
]);
const DAY = 86400000;
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function timestamp(value) {
  requireValue(
    typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "noncanonical timestamp",
  );
  return Date.parse(value);
}
function identifier(value) {
  requireValue(
    typeof value === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value),
    "invalid identifier",
  );
  return value;
}
function money(value, signed = false) {
  requireValue(
    typeof value === "string" &&
      (signed ? /^(?:0|-?[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value),
    "noncanonical money",
  );
  return BigInt(value);
}
const compareBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function inspectDataset(csv, simulation) {
  requireValue(
    simulation?.version === 1 && typeof simulation.seed === "string",
    "unsupported simulation",
  );
  const start = timestamp(simulation.startAt),
    end = timestamp(simulation.endAt);
  const days = simulation.days;
  requireValue(
    Number.isSafeInteger(days) &&
      days >= 1 &&
      days <= 365 &&
      end - start === days * DAY &&
      (start + 7 * 3600000) % DAY === 0,
    "invalid period",
  );
  requireValue(
    Array.isArray(simulation.customers) &&
      simulation.customers.length > 0 &&
      Array.isArray(simulation.accounts) &&
      Array.isArray(simulation.credits),
    "invalid registry",
  );
  const customers = new Map();
  for (const c of simulation.customers) {
    identifier(c.customerId);
    requireValue(!customers.has(c.customerId), "duplicate customer");
    requireValue(timestamp(c.createdAt) < end, "customer outside period");
    customers.set(c.customerId, {
      created: timestamp(c.createdAt),
      accounts: 0,
    });
  }
  const accounts = new Map();
  let openingTotal = 0n,
    minBalance = null;
  for (const a of simulation.accounts) {
    identifier(a.accountId);
    requireValue(!accounts.has(a.accountId), "duplicate account");
    const owner = customers.get(a.customerId),
      created = timestamp(a.createdAt);
    requireValue(
      owner &&
        owner.created <= created &&
        created < end &&
        ++owner.accounts <= 3,
      "invalid account owner or creation",
    );
    const balance = money(a.openingBalance);
    money(a.endingBalance);
    requireValue(
      created < start || balance === 0n,
      "new account has opening balance",
    );
    accounts.set(a.accountId, { ...a, balance, created });
    openingTotal += balance;
    if (minBalance === null || balance < minBalance) minBalance = balance;
  }
  requireValue(
    [...customers.values()].every((c) => c.accounts > 0),
    "customer without account",
  );
  let funding = money(simulation.initialFundingBalance, true);
  requireValue(openingTotal + funding === 0n, "opening conservation failed");
  const sequences = new Set();
  const credits = simulation.credits
    .map((c) => {
      const at = timestamp(c.occurredAt),
        a = accounts.get(c.accountId),
        amount = money(c.amount);
      requireValue(
        a && at >= start && at < end && at >= a.created && amount > 0n,
        "invalid funding credit",
      );
      requireValue(
        ["salary", "capital"].includes(c.kind) &&
          Number.isSafeInteger(c.sequence) &&
          c.sequence >= 0 &&
          !sequences.has(c.sequence),
        "invalid credit identity",
      );
      sequences.add(c.sequence);
      return { ...c, at, amount };
    })
    .sort((a, b) => a.at - b.at || a.sequence - b.sequence);
  let creditIndex = 0;
  const applyCredits = (until) => {
    while (creditIndex < credits.length && credits[creditIndex].at <= until) {
      const c = credits[creditIndex++],
        a = accounts.get(c.accountId);
      a.balance += c.amount;
      funding -= c.amount;
    }
  };
  requireValue(
    typeof csv === "string" && csv.endsWith("\n") && !csv.includes("\r"),
    "CSV must be LF terminated",
  );
  const lines = csv.slice(0, -1).split("\n");
  requireValue(lines.shift() === HEADER, "invalid CSV header");
  const transactions = new Set(),
    amounts = [],
    activity = new Map(),
    scenarioCounts = {};
  let previous = start,
    total = 0n,
    fraudTransactions = 0;
  for (const [index, line] of lines.entries()) {
    const row = line.split(",");
    requireValue(row.length === 12, "invalid CSV column count");
    const [
      tx,
      occurred,
      from,
      to,
      fromCustomer,
      toCustomer,
      rawAmount,
      rawBefore,
      fromCreated,
      toCreated,
      label,
      scenario,
    ] = row;
    identifier(tx);
    requireValue(!transactions.has(tx), "duplicate transaction");
    transactions.add(tx);
    const at = timestamp(occurred),
      source = accounts.get(from),
      target = accounts.get(to);
    requireValue(
      at >= previous && at >= start && at < end,
      "transaction time out of order or period",
    );
    previous = at;
    requireValue(
      source &&
        target &&
        from !== to &&
        source.customerId === fromCustomer &&
        target.customerId === toCustomer,
      "invalid transfer references",
    );
    requireValue(
      fromCreated === source.createdAt &&
        toCreated === target.createdAt &&
        source.created < at &&
        target.created < at,
      "invalid creation snapshot",
    );
    requireValue(
      (FRAUD.has(scenario) && label === "1") ||
        (LEGIT.has(scenario) && label === "0"),
      "invalid scenario label",
    );
    const amount = money(rawAmount),
      before = money(rawBefore);
    requireValue(amount > 0n, "transfer must be positive");
    applyCredits(at);
    requireValue(
      source.balance === before && before >= amount,
      `balance snapshot mismatch at row ${index + 1}`,
    );
    source.balance -= amount;
    target.balance += amount;
    total += amount;
    if (source.balance < minBalance) minBalance = source.balance;
    amounts.push(amount);
    fraudTransactions += label === "1" ? 1 : 0;
    scenarioCounts[scenario] = (scenarioCounts[scenario] ?? 0) + 1;
    const key = `${fromCustomer}:${Math.floor((at - start) / DAY)}`;
    activity.set(key, (activity.get(key) ?? 0) + 1);
  }
  applyCredits(end - 1);
  let ending = 0n;
  for (const a of accounts.values()) {
    requireValue(
      a.balance === money(a.endingBalance),
      "ending balance mismatch",
    );
    ending += a.balance;
  }
  requireValue(
    funding === money(simulation.endingFundingBalance, true) &&
      ending + funding === 0n,
    "ending conservation failed",
  );
  amounts.sort(compareBig);
  const amountAt = (p) =>
    String(amounts[Math.floor((amounts.length - 1) * p)] ?? 0n);
  const customerDays = customers.size * days,
    histogram = new Map([[0, customerDays - activity.size]]);
  for (const n of activity.values())
    histogram.set(n, (histogram.get(n) ?? 0) + 1);
  const buckets = [...histogram].sort((a, b) => a[0] - b[0]);
  const activityAt = (p) => {
    const position = Math.floor((customerDays - 1) * p);
    let count = 0;
    for (const [value, frequency] of buckets) {
      count += frequency;
      if (position < count) return value;
    }
    return 0;
  };
  return {
    sha256: createHash("sha256").update(csv).digest("hex"),
    transactions: lines.length,
    fraudTransactions,
    fraudRate: lines.length ? fraudTransactions / lines.length : 0,
    scenarioCounts,
    amount: {
      min: amountAt(0),
      p50: amountAt(0.5),
      p90: amountAt(0.9),
      p99: amountAt(0.99),
      max: amountAt(1),
    },
    activity: {
      customers: customers.size,
      days,
      customerDays,
      mean: lines.length / customerDays,
      p50: activityAt(0.5),
      p90: activityAt(0.9),
      max: activityAt(1),
    },
    totalDebits: String(total),
    totalCredits: String(total),
    endingCustomerBalances: String(ending),
    fundingBalance: String(funding),
    minBalance: String(minBalance),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      opts = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      requireValue(
        ["--csv", "--simulation"].includes(key) &&
          !(key in opts) &&
          args[i + 1] &&
          !args[i + 1].startsWith("--"),
        "invalid inspector argument",
      );
      opts[key] = args[i + 1];
    }
    requireValue(
      opts["--csv"] && opts["--simulation"],
      "csv and simulation are required",
    );
    console.log(
      JSON.stringify(
        inspectDataset(
          readFileSync(opts["--csv"], "utf8"),
          JSON.parse(readFileSync(opts["--simulation"], "utf8")),
        ),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
