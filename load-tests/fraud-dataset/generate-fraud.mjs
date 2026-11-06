import { generateDataset, COLUMNS } from "./generate.mjs";
import { inspectDataset } from "./inspect-fraud.mjs";
import { planScenarios } from "./scenarios.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function generateFraudDataset({
  seed = "dbs-fraud-v1",
  customers = 2000,
  days = 60,
} = {}) {
  if (typeof seed !== "string" || seed.length < 1 || seed.length > 128)
    throw new Error("seed must be 1–128 characters");
  if (
    !Number.isSafeInteger(customers) ||
    customers < 1000 ||
    customers > 100000
  )
    throw new Error("customers must be 1000–100000");
  if (!Number.isSafeInteger(days) || days < 30 || days > 90)
    throw new Error("days must be 30–90");
  const backgroundCustomers = Math.floor(customers * 0.75);
  const backgroundSeed = createHash("sha256")
    .update(`${seed}:normal`)
    .digest("hex");
  const background = generateDataset({
    seed: backgroundSeed,
    customers: backgroundCustomers,
    days,
  });
  let budget = Math.round(background.stats.transactions / 99),
    plan;
  for (let round = 0; round < 4; round++) {
    plan = planScenarios({
      seed,
      customers: customers - backgroundCustomers,
      days,
      budget,
    });
    const legitimate =
      background.stats.transactions +
      plan.transfers.filter(
        (t) => t.scenario === "NORMAL" || t.scenario.startsWith("HN_"),
      ).length;
    const adjusted = Math.round(legitimate / 99);
    if (adjusted === budget) break;
    budget = adjusted;
  }
  const accounts = new Map(
    plan.accounts.map((a) => [
      a.accountId,
      { ...a, balance: BigInt(a.openingBalance) },
    ]),
  );
  const opening = plan.accounts.reduce(
    (s, a) => s + BigInt(a.openingBalance),
    0n,
  );
  let funding = -opening;
  const credits = [...plan.credits].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence,
  );
  const transfers = [...plan.transfers].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence,
  );
  let nextCredit = 0;
  const creditUntil = (at) => {
    while (
      nextCredit < credits.length &&
      credits[nextCredit].occurredAt <= at
    ) {
      const c = credits[nextCredit++];
      accounts.get(c.accountId).balance += BigInt(c.amount);
      funding -= BigInt(c.amount);
    }
  };
  const lines = background.csv.trimEnd().split("\n").slice(1);
  for (const t of transfers) {
    creditUntil(t.occurredAt);
    const from = accounts.get(t.from),
      to = accounts.get(t.to),
      amount = BigInt(t.amount),
      before = from.balance;
    if (before < amount) throw new Error("insufficient planned funds");
    from.balance -= amount;
    to.balance += amount;
    // Identifier derived in the planner namespace; distinct from NORMAL transaction ids.
    const tx = t.txId;
    lines.push(
      [
        tx,
        t.occurredAt,
        t.from,
        t.to,
        from.customerId,
        to.customerId,
        t.amount,
        String(before),
        from.createdAt,
        to.createdAt,
        t.scenario === "NORMAL" || t.scenario.startsWith("HN_") ? "0" : "1",
        t.scenario,
      ].join(","),
    );
  }
  creditUntil(background.simulation.endAt);
  lines.sort((a, b) => {
    const ta = a.slice(37, 61),
      tb = b.slice(37, 61);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const csv = COLUMNS.join(",") + "\n" + lines.join("\n") + "\n";
  const simulation = {
    ...background.simulation,
    seed,
    customers: [...background.simulation.customers, ...plan.customers],
    accounts: [
      ...background.simulation.accounts,
      ...[...accounts.values()].map(({ balance, ...a }) => ({
        ...a,
        endingBalance: String(balance),
      })),
    ],
    credits: [...background.simulation.credits, ...plan.credits].map(
      (c, i) => ({ ...c, sequence: i }),
    ),
    initialFundingBalance: String(
      BigInt(background.simulation.initialFundingBalance) - opening,
    ),
    endingFundingBalance: String(
      BigInt(background.simulation.endingFundingBalance) + funding,
    ),
  };
  const stats = inspectDataset(csv, simulation);
  const required = [
    "ATO_DRAIN",
    "MULE_FANOUT",
    "VELOCITY_BURST",
    "BUST_OUT",
    "ROUND_TRIP",
    "SLOW_DRIP",
    "STRUCTURING",
    "FAN_IN",
    "HN_RENT",
    "HN_SELF_TRANSFER",
    "HN_NEW_SALARY",
    "HN_GROUP_MEAL",
    "HN_BORROW_REPAY",
  ];
  if (
    required.some((s) => !stats.scenarioCounts[s]) ||
    stats.fraudRate < 0.008 ||
    stats.fraudRate > 0.012
  )
    throw new Error("scenario budget cannot meet prevalence");
  return { csv, simulation, stats };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      opts = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.startsWith("--") ? args[i].slice(2) : "";
      if (
        !["seed", "customers", "days", "output"].includes(key) ||
        key in opts ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw new Error("invalid generator argument");
      opts[key] = args[i + 1];
    }
    for (const key of ["customers", "days"])
      if (key in opts) {
        if (!/^\d+$/.test(opts[key]))
          throw new Error(`${key} must be an integer`);
        opts[key] = Number(opts[key]);
      }
    const {
      output = fileURLToPath(
        new URL("../results/fraud-mixed.csv", import.meta.url),
      ),
      ...options
    } = opts;
    const { csv, simulation, stats } = generateFraudDataset(options),
      path = resolve(output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv, "utf8");
    writeFileSync(
      path + ".simulation.json",
      JSON.stringify(simulation) + "\n",
      "utf8",
    );
    writeFileSync(path + ".stats.json", JSON.stringify(stats) + "\n", "utf8");
    console.log(JSON.stringify(stats));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
