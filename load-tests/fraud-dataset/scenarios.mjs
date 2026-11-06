import { createHash } from "node:crypto";
const DAY = 86400000,
  HOUR = 3600000;
const START = Date.parse("2026-01-01T00:00:00+07:00");
const iso = (at) => new Date(at).toISOString();

export function planScenarios({ seed, customers, days, budget }) {
  let state = createHash("sha256")
    .update(`${seed}:cohort-random`)
    .digest()
    .readUInt32LE(0);
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
  const identifier = (kind, index) => {
    const h = createHash("sha256")
      .update(`${seed}:cohort:${kind}:${index}`)
      .digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const registry = Array.from({ length: customers }, (_, i) => ({
    customerId: identifier("customer", i),
    createdAt: iso(START - 200 * DAY),
  }));
  const accounts = registry.map((c, i) => ({
    accountId: identifier("account", i),
    customerId: c.customerId,
    createdAt: c.createdAt,
    openingBalance: "0",
  }));
  const credits = [],
    transfers = [];
  let cursor = 0;
  const allocate = (opening = 0n, createdAt = null) => {
    if (cursor >= registry.length)
      throw new Error("insufficient scenario cohort");
    const i = cursor++,
      a = accounts[i];
    a.openingBalance = String(opening);
    if (createdAt !== null)
      a.createdAt = registry[i].createdAt = iso(createdAt);
    return a;
  };
  const emit = (from, to, at, amount, scenario) => {
    if (typeof amount !== "bigint" || amount <= 0n)
      throw new Error("invalid planned amount");
    transfers.push({
      txId: identifier("transaction", transfers.length),
      from: from.accountId,
      to: to.accountId,
      occurredAt: iso(at),
      amount: String(amount),
      scenario,
      sequence: transfers.length,
    });
  };
  const when = () =>
    START +
    (2 + Math.floor(random() * (days - 10))) * DAY +
    (9 + Math.floor(random() * 7)) * HOUR +
    Math.floor(random() * 1800) * 1000;
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
  const q = Math.max(1, Math.floor(budget / 8));

  const atoTargets = Array.from({ length: 6 }, () => allocate());
  for (let i = 0; i < Math.max(1, Math.floor(q / 6)); i++) {
    const balance = BigInt(integer(20000, 50000)) * 1000n,
      source = allocate(balance),
      at = when();
    let remaining = balance;
    for (let j = 0; j < 6; j++) {
      const amount =
        j === 5 ? (remaining * 95n) / 100n : BigInt(integer(100, 400)) * 1000n;
      emit(source, atoTargets[j], at + j * 45000, amount, "ATO_DRAIN");
      remaining -= amount;
    }
  }
  const muleTargets = Array.from({ length: 6 }, () => allocate());
  const muleEpisodes = Math.max(1, Math.floor(q / 7)),
    upstream = allocate(BigInt(muleEpisodes) * 30000000n);
  for (let i = 0; i < muleEpisodes; i++) {
    const mule = allocate(),
      at = when(),
      incoming = BigInt(integer(20000, 30000)) * 1000n;
    emit(upstream, mule, at - 60000, incoming, "MULE_FANOUT");
    let remaining = incoming;
    for (let j = 0; j < 6; j++) {
      const amount = j === 5 ? remaining : incoming / 6n;
      emit(mule, muleTargets[j], at + j * 45000, amount, "MULE_FANOUT");
      remaining -= amount;
    }
  }
  const burstTarget = allocate();
  for (let i = 0; i < Math.max(1, Math.floor(q / 6)); i++) {
    const source = allocate(50000000n),
      at = when();
    for (let j = 0; j < 6; j++)
      emit(
        source,
        burstTarget,
        at + j * 30000,
        BigInt(integer(50, 500)) * 1000n,
        "VELOCITY_BURST",
      );
  }
  const bustTarget = allocate();
  for (let i = 0; i < q; i++) {
    const at = when(),
      source = allocate(0n, at - HOUR),
      capital = BigInt(integer(20000, 40000)) * 1000n;
    credits.push({
      accountId: source.accountId,
      occurredAt: iso(at - HOUR + 60000),
      amount: String(capital),
      kind: "capital",
      sequence: credits.length,
    });
    emit(source, bustTarget, at, (capital * 95n) / 100n, "BUST_OUT");
  }
  const roundA = allocate(20000000n),
    roundB = allocate(),
    roundAt = when();
  for (let i = 0; i < Math.max(1, Math.floor(q / 2)); i++) {
    const amount = BigInt(integer(1000, 5000)) * 1000n,
      at = roundAt + i * 120000;
    emit(roundA, roundB, at, amount, "ROUND_TRIP");
    emit(roundB, roundA, at + 60000, amount, "ROUND_TRIP");
  }
  const warmup = (source, target, amount, at) => {
    for (let j = 0; j < 5; j++)
      emit(source, target, at - DAY + j * 2 * HOUR, amount, "NORMAL");
  };
  const dripTarget = allocate();
  for (let i = 0; i < Math.max(1, Math.floor(q / 7)); i++) {
    const source = allocate(50000000n),
      amount = BigInt(integer(50, 200)) * 1000n,
      at = when();
    warmup(source, dripTarget, amount, at);
    for (let j = 0; j < 7; j++)
      emit(source, dripTarget, at + j * DAY, amount, "SLOW_DRIP");
  }
  const structTarget = allocate();
  for (let i = 0; i < Math.max(1, Math.floor(q / 6)); i++) {
    const source = allocate(500000000n),
      amount = BigInt(integer(9500, 9900)) * 1000n,
      at = when();
    warmup(source, structTarget, amount, at);
    for (let j = 0; j < 6; j++)
      emit(
        source,
        structTarget,
        at + Math.floor(j / 2) * DAY + (j % 2) * 3 * HOUR,
        amount,
        "STRUCTURING",
      );
  }
  const faninTarget = allocate();
  for (let i = 0; i < Math.max(1, Math.floor(q / 6)); i++) {
    const at = when();
    for (let j = 0; j < 6; j++) {
      const source = allocate(50000000n),
        amount = BigInt(integer(100, 500)) * 1000n;
      warmup(source, faninTarget, amount, at);
      emit(source, faninTarget, at + j * 30000, amount, "FAN_IN");
    }
  }
  const tenant = allocate(200000000n),
    landlord = allocate(),
    rent = BigInt(integer(5000, 15000)) * 1000n;
  for (let day = 0; day < days; day += 29) {
    for (let j = 0; j < 5; j++)
      emit(
        tenant,
        landlord,
        START + day * DAY + (8 + j * 2) * HOUR,
        BigInt(integer(100, 200)) * 1000n,
        "NORMAL",
      );
    emit(tenant, landlord, START + day * DAY + 18 * HOUR, rent, "HN_RENT");
  }
  const selfSource = allocate(25000000n);
  const selfTarget = {
    accountId: identifier("second-account", accounts.length),
    customerId: selfSource.customerId,
    createdAt: selfSource.createdAt,
    openingBalance: "0",
  };
  accounts.push(selfTarget);
  emit(selfSource, selfTarget, when(), 23750000n, "HN_SELF_TRANSFER");
  const salaryAt = when(),
    newSalary = allocate(0n, salaryAt - HOUR),
    salaryTarget = allocate();
  credits.push({
    accountId: newSalary.accountId,
    occurredAt: iso(salaryAt - 1800000),
    amount: "25000000",
    kind: "salary",
    sequence: credits.length,
  });
  emit(newSalary, salaryTarget, salaryAt, 20000000n, "HN_NEW_SALARY");
  const diner = allocate(10000000n),
    mealAt = when();
  for (let j = 0; j < 5; j++)
    emit(
      diner,
      allocate(),
      mealAt + j * 60000,
      BigInt(integer(50, 500)) * 1000n,
      "HN_GROUP_MEAL",
    );
  const lender = allocate(25000000n),
    borrower = allocate(),
    borrowAt = when(),
    borrow = BigInt(integer(1000, 5000)) * 1000n;
  emit(lender, borrower, borrowAt, borrow, "HN_BORROW_REPAY");
  emit(borrower, lender, borrowAt + 900000, borrow, "HN_BORROW_REPAY");
  return { customers: registry, accounts, credits, transfers };
}
