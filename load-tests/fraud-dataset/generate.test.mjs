import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateDataset, COLUMNS } from './generate.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const dataset = generateDataset();
const rows = dataset.csv.trimEnd().split('\n').map((line) => line.split(','));

test('TC-71-01: fixed seed is byte identical and a changed seed differs', () => {
  assert.equal(digest(dataset.csv), digest(generateDataset().csv));
  assert.notEqual(digest(dataset.csv), digest(generateDataset({ seed: 'dbs-normal-v2' }).csv));
  assert.ok(rows.length > 90000 && rows.length < 125000, `rows=${rows.length}`);
});

test('TC-71-02: distinct habits, familiar recipients, skew and payday peak', () => {
  const { stats, profiles } = dataset;
  assert.equal(profiles.length, 2000);
  assert.ok(profiles.every((p) => p.familiar.length >= 3 && p.familiar.length <= 8));
  assert.ok(stats.minLambda < 0.35 && stats.maxLambda > 2.5);
  assert.ok(stats.familiarShare >= 0.75 && stats.familiarShare <= 0.85);
  assert.ok(stats.p90Amount > 2 * stats.p50Amount);
  assert.ok(stats.activeHourShare > 0.55);
  assert.ok(stats.paydayRateRatio >= 1.3);
  assert.equal(stats.salaryCredits, 4000);
});

test('TC-71-03/04: exact schema, valid references, sorted positive transfers and conservation', () => {
  assert.deepEqual(rows[0], COLUMNS);
  assert.equal(COLUMNS.length, 12);
  const accounts = new Map(dataset.profiles.map((p) => [p.accountId, p]));
  const txIds = new Set();
  let previous = '';
  for (const row of rows.slice(1)) {
    assert.equal(row.length, 12);
    const [tx, at, from, to, fromCustomer, toCustomer, amount, before, fromCreated, toCreated, fraud, scenario] = row;
    assert.match(tx, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.ok(!txIds.has(tx)); txIds.add(tx);
    assert.ok(at >= previous); previous = at;
    assert.ok(accounts.has(from) && accounts.has(to) && from !== to);
    assert.equal(accounts.get(from).customerId, fromCustomer);
    assert.equal(accounts.get(to).customerId, toCustomer);
    assert.ok(BigInt(amount) > 0n && BigInt(before) >= BigInt(amount));
    assert.ok(fromCreated < at && toCreated < at);
    assert.equal(fraud, '0'); assert.equal(scenario, 'NORMAL');
  }
  assert.equal(dataset.stats.minBalance >= 0n, true);
  assert.equal(dataset.stats.totalDebits, dataset.stats.totalCredits);
  assert.equal(dataset.stats.endingCustomerBalances + dataset.stats.fundingBalance, 0n);
});

test('TC-71-05: CLI writes selected path and rejects invalid arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbs71-'));
  const output = join(dir, 'normal.csv');
  const script = fileURLToPath(new URL('./generate.mjs', import.meta.url));
  const good = spawnSync(process.execPath, [script, '--customers', '20', '--days', '4', '--output', output], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.ok(readFileSync(output, 'utf8').startsWith(COLUMNS.join(',') + '\n'));
  const invalid = join(dir, 'invalid.csv');
  const bad = spawnSync(process.execPath, [script, '--customers', '0', '--output', invalid], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.equal(existsSync(invalid), false);
});
