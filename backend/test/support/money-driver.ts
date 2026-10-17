/**
 * Manual-test driver for @common/money (DBS-22 §5). Run from backend/, in Git Bash:
 *
 *   npx ts-node -r tsconfig-paths/register test/support/money-driver.ts table
 *   npx ts-node -r tsconfig-paths/register test/support/money-driver.ts serve
 *
 * `table` feeds boundary values through the real validator, the parsers, the formatters and
 * JSON.stringify and prints what each one decided. `serve` starts a small Nest app with the REAL
 * `configureHttpApp` (global pipe, filter, serializer) and one probe endpoint, so `curl` can post
 * to it. Nothing here touches a database. It lives under test/, so `nest build` never ships it.
 */
import '@common/money/bigint-json.bootstrap'; // what main.ts does, so the printed JSON is the app's
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { validate } from 'class-validator';
import {
  BALANCE_ZERO,
  MONEY_MAX,
  MONEY_ZERO,
  MoneyError,
  addMoney,
  creditBalance,
  debitBalance,
  formatBalance,
  formatMoney,
  parseMoney,
  parsePositiveMoney,
  subtractMoney,
  toBalance,
} from '@common/money';
import { configureHttpApp } from '../../src/app.setup';
import { MoneyProbeController, MoneyProbeDto } from './money-probe';

const PORT = 3999;

/** The value, or the `MoneyError` reason, as one short word for the table. */
function outcome(fn: () => unknown): string {
  try {
    const value = fn();
    return typeof value === 'bigint' ? `${value}n` : JSON.stringify(value);
  } catch (error) {
    if (error instanceof MoneyError) return error.reason;
    return `THROWS ${String(error)}`;
  }
}

async function validatorSays(value: unknown): Promise<'ACCEPT' | 'REJECT'> {
  const errors = await validate(Object.assign(new MoneyProbeDto(), { amount: value }));
  return errors.length === 0 ? 'ACCEPT' : 'REJECT';
}

const row = (cells: string[], widths: number[]): string =>
  cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');

async function table(): Promise<void> {
  const widths = [26, 8, 22, 22, 26, 26, 5];
  console.log('=== M-22-01, M-22-02: validator and parsers on boundary values ===');
  console.log(
    row(
      [
        'input',
        'DTO',
        'parseMoney',
        'parsePositiveMoney',
        'formatMoney(parse)',
        'JSON.stringify',
        'same',
      ],
      widths,
    ),
  );
  const inputs = [
    '9007199254740993', // 2^53 + 1
    '9223372036854775807', // 2^63 - 1
    '9223372036854775808', // 2^63
    '0',
    '-1',
    '1.5',
    '1e3',
    '01',
    ' 1',
  ];
  for (const input of inputs) {
    const parsed = outcome(() => parseMoney(input));
    const ok = !parsed.match(/^[A-Z_]+$/) && !parsed.startsWith('THROWS');
    const formatted = ok ? outcome(() => formatMoney(parseMoney(input))) : '-';
    const json = ok ? JSON.stringify(parseMoney(input)) : '-';
    const same = ok
      ? String(formatted === JSON.stringify(input) && json === JSON.stringify(input))
      : '-';
    console.log(
      row(
        [
          JSON.stringify(input),
          await validatorSays(input),
          parsed,
          outcome(() => parsePositiveMoney(input)),
          formatted,
          json,
          same,
        ],
        widths,
      ),
    );
  }

  console.log('\n=== not a string: the validator refuses every one ===');
  for (const value of [1000, Number('9007199254740993'), null, undefined, [], ['1'], {}]) {
    console.log(
      row([String(JSON.stringify(value) ?? 'undefined'), await validatorSays(value)], [26, 8]),
    );
  }

  console.log('\n=== M-22-03: what a JSON number does to 2^53 + 1 ===');
  const asNumber = (JSON.parse('{"amount":9007199254740993}') as { amount: number }).amount;
  console.log(
    `JSON.parse('{"amount":9007199254740993}').amount = ${asNumber}  (typeof ${typeof asNumber})`,
  );
  console.log(
    `  validator on that number : ${await validatorSays(asNumber)}   <- digits already lost, refused`,
  );
  console.log(
    `  validator on the string  : ${await validatorSays('9007199254740993')}   <- same digits, kept`,
  );

  console.log('\n=== M-22-04: arithmetic and the funding account ===');
  const one = parseMoney('1');
  console.log(
    `2^53 + 1                       = ${outcome(() => addMoney(parseMoney('9007199254740992'), one))}`,
  );
  console.log(`MAX + 1                        = ${outcome(() => addMoney(MONEY_MAX, one))}`);
  console.log(`0 - 1                          = ${outcome(() => subtractMoney(MONEY_ZERO, one))}`);
  const deposit = parseMoney('300000');
  let funding = debitBalance(BALANCE_ZERO, deposit);
  const a = creditBalance(BALANCE_ZERO, deposit);
  console.log(`funding after deposit 1        = ${formatBalance(funding)}`);
  funding = debitBalance(funding, deposit);
  const b = creditBalance(BALANCE_ZERO, deposit);
  console.log(`funding after deposit 2        = ${formatBalance(funding)}`);
  console.log(
    `funding + A + B                = ${formatBalance(toBalance(funding + a + b))}   (A=${a}, B=${b})`,
  );
}

async function serve(): Promise<void> {
  @Module({ controllers: [MoneyProbeController] })
  class ProbeModule {}

  const app = await NestFactory.create<NestExpressApplication>(ProbeModule, {
    logger: ['error', 'warn'],
  });
  configureHttpApp(app, { trustProxyHops: 0, corsOrigins: [], isProduction: false });
  app.get(MoneyProbeController).onCall = dto =>
    console.log(`handler ran: amount=${JSON.stringify(dto.amount)}`);
  await app.listen(PORT, '127.0.0.1');
  console.log(
    `Probe listening on http://127.0.0.1:${PORT}  (POST /v1/probe/money). Ctrl+C to stop.`,
  );
}

const mode = process.argv[2];
if (mode === 'table') {
  void table();
} else if (mode === 'serve') {
  void serve();
} else {
  console.error('usage: money-driver.ts table | serve');
  process.exit(1);
}
