import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLUMNS = Object.freeze([
  'tx_id', 'occurred_at', 'from_account', 'to_account', 'from_customer',
  'to_customer', 'amount', 'from_balance_before', 'from_account_created_at',
  'to_account_created_at', 'is_fraud', 'scenario',
]);

const DAY_MS = 86_400_000;
const START_MS = Date.parse('2026-01-01T00:00:00+07:00');

function randomSource(seed) {
  const hash = createHash('sha256').update(seed).digest();
  let state = hash.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function uuid(seed, kind, index) {
  const bytes = createHash('sha256').update(`${seed}:${kind}:${index}`).digest('hex');
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-a${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`;
}

function gaussian(random) {
  return Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) *
    Math.cos(2 * Math.PI * random());
}

function poisson(random, rate) {
  const limit = Math.exp(-rate);
  let product = 1;
  let count = 0;
  do { count++; product *= random(); } while (product > limit);
  return count - 1;
}

function quantile(sorted, fraction) {
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function assertOptions({ seed, customers, days }) {
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 128) {
    throw new Error('seed must be 1–128 characters');
  }
  if (!Number.isSafeInteger(customers) || customers < 9 || customers > 100_000) {
    throw new Error('customers must be an integer from 9 to 100000');
  }
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error('days must be an integer from 1 to 365');
  }
}

export function generateDataset({ seed = 'dbs-normal-v1', customers = 2000, days = 60 } = {}) {
  assertOptions({ seed, customers, days });
  const random = randomSource(seed);
  const profiles = Array.from({ length: customers }, (_, index) => {
    const familiar = new Set();
    const desired = 3 + Math.floor(random() * 6);
    while (familiar.size < desired) {
      const target = Math.floor(random() * customers);
      if (target !== index) familiar.add(target);
    }
    return {
      customerId: uuid(seed, 'customer', index),
      accountId: uuid(seed, 'account', index),
      createdAt: new Date(START_MS - (30 + Math.floor(random() * 700)) * DAY_MS).toISOString(),
      balance: BigInt((30_000 + Math.floor(random() * 70_000)) * 1000),
      medianAmount: Math.exp(Math.log(100_000) + random() * Math.log(30)),
      lambda: 0.3 + 2.7 * random() ** 4,
      preferredHour: random() < 0.65 ? 9 + Math.floor(random() * 9) : 18 + Math.floor(random() * 4),
      familiar: [...familiar],
      salaryDay: Math.floor(random() * 30),
      salaryAmount: BigInt((12_000 + Math.floor(random() * 38_000)) * 1000),
    };
  });
  const initialCustomerBalances = profiles.reduce((sum, p) => sum + p.balance, 0n);
  let fundingBalance = -initialCustomerBalances;
  let totalDebits = 0n;
  let totalCredits = 0n;
  let minBalance = profiles.reduce((min, p) => p.balance < min ? p.balance : min, profiles[0].balance);
  let salaryCredits = 0;
  let familiarTransfers = 0;
  let activeHourTransfers = 0;
  let paydayCandidates = 0;
  let otherCandidates = 0;
  let paydayExposure = 0;
  let otherExposure = 0;
  const amounts = [];
  const lines = [COLUMNS.join(',')];
  let transactionIndex = 0;

  for (let day = 0; day < days; day++) {
    const candidates = [];
    for (let fromIndex = 0; fromIndex < customers; fromIndex++) {
      const source = profiles[fromIndex];
      const payday = day % 30 === source.salaryDay;
      if (payday) {
        source.balance += source.salaryAmount;
        fundingBalance -= source.salaryAmount;
        salaryCredits++;
        paydayExposure++;
      } else {
        otherExposure++;
      }
      const count = poisson(random, source.lambda * (payday ? 1.7 : 1));
      if (payday) paydayCandidates += count; else otherCandidates += count;
      for (let n = 0; n < count; n++) {
        const familiar = random() < 0.8;
        const targetIndex = familiar
          ? source.familiar[Math.floor(random() * source.familiar.length)]
          : (() => { const r = Math.floor(random() * (customers - 1)); return r >= fromIndex ? r + 1 : r; })();
        const hour = random() < 0.85
          ? Math.min(21, Math.max(9, source.preferredHour + Math.floor(random() * 5) - 2))
          : Math.floor(random() * 24);
        const timestamp = START_MS + day * DAY_MS + (hour * 3600 + Math.floor(random() * 3600)) * 1000;
        const sampled = Math.max(1000, Math.round(source.medianAmount * Math.exp(0.8 * gaussian(random)) / 1000) * 1000);
        candidates.push({ fromIndex, targetIndex, timestamp, sampled, hour });
      }
    }
    candidates.sort((a, b) => a.timestamp - b.timestamp || a.fromIndex - b.fromIndex || a.targetIndex - b.targetIndex);
    for (const item of candidates) {
      const source = profiles[item.fromIndex];
      const target = profiles[item.targetIndex];
      const amount = BigInt(Math.min(item.sampled, Number(source.balance)));
      if (amount < 1000n) continue;
      const before = source.balance;
      source.balance -= amount;
      target.balance += amount;
      if (source.balance < 0n) throw new Error('negative customer balance');
      if (source.balance < minBalance) minBalance = source.balance;
      totalDebits += amount;
      totalCredits += amount;
      amounts.push(Number(amount));
      if (source.familiar.includes(item.targetIndex)) familiarTransfers++;
      if (item.hour >= 9 && item.hour <= 22) activeHourTransfers++;
      lines.push([
        uuid(seed, 'transaction', transactionIndex++), new Date(item.timestamp).toISOString(),
        source.accountId, target.accountId, source.customerId, target.customerId,
        amount.toString(), before.toString(), source.createdAt, target.createdAt, '0', 'NORMAL',
      ].join(','));
    }
  }

  const endingCustomerBalances = profiles.reduce((sum, p) => sum + p.balance, 0n);
  if (totalDebits !== totalCredits || endingCustomerBalances + fundingBalance !== 0n) {
    throw new Error('money conservation failed');
  }
  amounts.sort((a, b) => a - b);
  const transactions = lines.length - 1;
  const stats = {
    transactions,
    minLambda: Math.min(...profiles.map((p) => p.lambda)),
    maxLambda: Math.max(...profiles.map((p) => p.lambda)),
    familiarShare: familiarTransfers / transactions,
    activeHourShare: activeHourTransfers / transactions,
    paydayRateRatio: (paydayCandidates / paydayExposure) / (otherCandidates / otherExposure),
    p50Amount: quantile(amounts, 0.5),
    p90Amount: quantile(amounts, 0.9),
    salaryCredits,
    minBalance,
    totalDebits,
    totalCredits,
    endingCustomerBalances,
    fundingBalance,
  };
  return { csv: lines.join('\n') + '\n', profiles, stats };
}

function cliOptions(args) {
  const options = {};
  const allowed = new Set(['seed', 'customers', 'days', 'output']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.has(key) || !args[i + 1] || args[i + 1].startsWith('--') || key in options) {
      throw new Error(`invalid argument: ${args[i] ?? ''}`);
    }
    options[key] = args[i + 1];
  }
  for (const key of ['customers', 'days']) {
    if (key in options) {
      if (!/^[0-9]+$/.test(options[key])) throw new Error(`${key} must be an integer`);
      options[key] = Number(options[key]);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output = fileURLToPath(new URL('../results/fraud-normal.csv', import.meta.url)), ...options } = cliOptions(process.argv.slice(2));
    const { csv, stats } = generateDataset(options);
    const path = resolve(output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv, 'utf8');
    console.log(JSON.stringify({ output: path, sha256: createHash('sha256').update(csv).digest('hex'), ...stats },
      (_, value) => typeof value === 'bigint' ? value.toString() : value));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
