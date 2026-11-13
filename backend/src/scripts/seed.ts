import { resolve } from 'node:path';
import { DEFAULT_KEY_DIR, mintDevToken } from './dev-auth';

export const OPERATOR_SUB = 'demo-operator';

export interface SeedCustomerAccountPlan {
  type: 'CHECKING' | 'SAVINGS';
  initialDeposit: string;
  depositIdempotencyKey: string;
}

export interface SeedCustomerPlan {
  sub: string;
  fullName: string;
  accounts: SeedCustomerAccountPlan[];
}

export interface SeedTransferPlan {
  fromSub: string;
  fromAccountType: 'CHECKING' | 'SAVINGS';
  toSub: string;
  toAccountType: 'CHECKING' | 'SAVINGS';
  amount: string;
  idempotencyKey: string;
}

export const SEED_CUSTOMERS: readonly SeedCustomerPlan[] = [
  {
    sub: 'demo-customer-minh-anh',
    fullName: 'Nguyễn Minh Anh',
    accounts: [
      {
        type: 'CHECKING',
        initialDeposit: '50000000',
        depositIdempotencyKey: '70000000-0000-4000-8000-000000000001',
      },
      {
        type: 'SAVINGS',
        initialDeposit: '20000000',
        depositIdempotencyKey: '70000000-0000-4000-8000-000000000002',
      },
    ],
  },
  {
    sub: 'demo-customer-thu-ha',
    fullName: 'Trần Thu Hà',
    accounts: [
      {
        type: 'CHECKING',
        initialDeposit: '10000000',
        depositIdempotencyKey: '70000000-0000-4000-8000-000000000003',
      },
    ],
  },
  {
    sub: 'demo-customer-van-binh',
    fullName: 'Nguyễn Văn Bình',
    accounts: [
      {
        type: 'CHECKING',
        initialDeposit: '5000000',
        depositIdempotencyKey: '70000000-0000-4000-8000-000000000004',
      },
    ],
  },
] as const;

export const SEED_TRANSFERS: readonly SeedTransferPlan[] = [
  {
    fromSub: 'demo-customer-minh-anh',
    fromAccountType: 'CHECKING',
    toSub: 'demo-customer-thu-ha',
    toAccountType: 'CHECKING',
    amount: '2000000',
    idempotencyKey: '70000000-0000-4000-8000-000000000005',
  },
  {
    fromSub: 'demo-customer-thu-ha',
    fromAccountType: 'CHECKING',
    toSub: 'demo-customer-van-binh',
    toAccountType: 'CHECKING',
    amount: '500000',
    idempotencyKey: '70000000-0000-4000-8000-000000000006',
  },
] as const;

export interface SeedTokens {
  operator: string;
  customers: Record<string, string>;
}

export interface SeedOptions {
  baseUrl: string;
  authMode?: 'local' | 'cloud';
  keyDir?: string;
  tokens?: SeedTokens;
  quiet?: boolean;
}

export interface SeedAccountResult {
  id: string;
  type: 'CHECKING' | 'SAVINGS';
  status: string;
  reused: boolean;
  finalBalance: string;
}

export interface SeedCustomerResult {
  sub: string;
  fullName: string;
  customerId: string;
  accounts: SeedAccountResult[];
}

/** Status of a step that the seed did not send because the balance already shows its effect. */
export const SEED_STEP_SKIPPED = 'SKIPPED_ALREADY_APPLIED';

export interface SeedDepositResult {
  toAccountId: string;
  amount: string;
  /** `null` when the step was skipped (nothing was sent, so there is no transfer to name). */
  transferId: string | null;
  status: string;
  /** BL-213: the balance already reflected this deposit, so it was not sent again. */
  skipped?: boolean;
}

export interface SeedTransferResult {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  transferId: string | null;
  status: string;
  skipped?: boolean;
}

export interface SeedReport {
  baseUrl: string;
  customers: SeedCustomerResult[];
  deposits: SeedDepositResult[];
  transfers: SeedTransferResult[];
}

export class SeedError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'SeedError';
  }
}

interface RawAccountDto {
  id: string;
  type: 'CHECKING' | 'SAVINGS' | 'SYSTEM';
  status: string;
  balance?: string;
  createdAt?: string;
}

interface RawCustomerProfileDto {
  id: string;
  fullName: string;
  createdAt: string;
}

interface RawTransferResultDto {
  transferId: string;
  status: string;
}

function cleanBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function requestJson<T>(
  url: string,
  method: string,
  token: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SeedError(`Network request failed for ${method} ${url}: ${message}`);
  }

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch {
    parsed = rawText;
  }

  if (!response.ok) {
    const errorDetail =
      typeof parsed === 'string'
        ? parsed
        : typeof parsed === 'object' && parsed !== null
          ? JSON.stringify(parsed)
          : response.statusText;
    throw new SeedError(
      `HTTP ${response.status} ${response.statusText} from ${method} ${url}: ${errorDetail}`,
      response.status,
      parsed,
    );
  }

  return { status: response.status, data: parsed as T };
}

export async function resolveTokens(
  options: SeedOptions,
  cliCloudTokens?: {
    operatorToken?: string;
    customer1Token?: string;
    customer2Token?: string;
    customer3Token?: string;
  },
): Promise<SeedTokens> {
  if (options.tokens) {
    return options.tokens;
  }

  const authMode = options.authMode ?? 'local';
  if (authMode === 'local') {
    const dir = options.keyDir ?? DEFAULT_KEY_DIR;
    const operator = await mintDevToken({ role: 'operator', sub: OPERATOR_SUB, dir });
    const customers: Record<string, string> = {};
    for (const customer of SEED_CUSTOMERS) {
      customers[customer.sub] = await mintDevToken({
        role: 'customer',
        sub: customer.sub,
        dir,
      });
    }
    return { operator, customers };
  }

  // Cloud mode
  const operator = cliCloudTokens?.operatorToken ?? process.env.DBS_OPERATOR_TOKEN;
  const c1 = cliCloudTokens?.customer1Token ?? process.env.DBS_CUSTOMER_1_TOKEN;
  const c2 = cliCloudTokens?.customer2Token ?? process.env.DBS_CUSTOMER_2_TOKEN;
  const c3 = cliCloudTokens?.customer3Token ?? process.env.DBS_CUSTOMER_3_TOKEN;

  if (!operator) {
    throw new SeedError(
      'Missing operator token for cloud auth. Provide --operator-token or DBS_OPERATOR_TOKEN.',
    );
  }
  if (!c1 || !c2 || !c3) {
    throw new SeedError(
      'Missing customer tokens for cloud auth. Provide --customer1-token, --customer2-token, --customer3-token (or DBS_CUSTOMER_{1,2,3}_TOKEN).',
    );
  }

  return {
    operator,
    customers: {
      'demo-customer-minh-anh': c1,
      'demo-customer-thu-ha': c2,
      'demo-customer-van-binh': c3,
    },
  };
}

const accountKey = (sub: string, type: string): string => `${sub}:${type}`;

export interface SeedBalanceTrail {
  /** Per account: the balances it passes through, index 0 = empty, 1 = after the deposit, then one per transfer that touches it. */
  trails: Map<string, bigint[]>;
  /** Per transfer: the index in the trail of the sender and of the receiver once that transfer is applied. */
  transferPositions: { from: number; to: number }[];
}

/**
 * BL-213: the seed decides from the balance whether a step already happened, so it must know which
 * balance each step leaves behind. Deposits come first, then the transfers in order (the order
 * `runSeed` executes them in).
 */
export function planBalanceTrail(
  customers: readonly SeedCustomerPlan[] = SEED_CUSTOMERS,
  transfers: readonly SeedTransferPlan[] = SEED_TRANSFERS,
): SeedBalanceTrail {
  const trails = new Map<string, bigint[]>();
  for (const customer of customers) {
    for (const account of customer.accounts) {
      trails.set(accountKey(customer.sub, account.type), [0n, BigInt(account.initialDeposit)]);
    }
  }
  const transferPositions = transfers.map(transfer => {
    const fromKey = accountKey(transfer.fromSub, transfer.fromAccountType);
    const toKey = accountKey(transfer.toSub, transfer.toAccountType);
    const fromTrail = trails.get(fromKey);
    const toTrail = trails.get(toKey);
    if (!fromTrail || !toTrail) {
      throw new SeedError(
        `Transfer plan references an account missing from the plan: ${fromKey} -> ${toKey}`,
      );
    }
    const amount = BigInt(transfer.amount);
    fromTrail.push(fromTrail[fromTrail.length - 1] - amount);
    toTrail.push(toTrail[toTrail.length - 1] + amount);
    return { from: fromTrail.length - 1, to: toTrail.length - 1 };
  });
  return { trails, transferPositions };
}

function divergence(what: string, key: string, balance: bigint, trail: bigint[]): SeedError {
  return new SeedError(
    `Seed stopped before ${what}: the balance of ${key} is ${balance}, which is not one of the ` +
      `balances the demo plan passes through (${trail.join(', ')}). Something else changed this ` +
      `account, so the seed cannot tell which steps already ran and will not move money. ` +
      `Rebuild the database (or fix the account) and run the seed again.`,
  );
}

export async function runSeed(
  options: SeedOptions,
  cliCloudTokens?: {
    operatorToken?: string;
    customer1Token?: string;
    customer2Token?: string;
    customer3Token?: string;
  },
): Promise<SeedReport> {
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const tokens = await resolveTokens(options, cliCloudTokens);

  const customerResults: SeedCustomerResult[] = [];
  const accountLookup = new Map<string, SeedAccountResult>(); // `${sub}:${type}` -> account result

  // 1. Onboarding & Account setup
  for (const plan of SEED_CUSTOMERS) {
    const customerToken = tokens.customers[plan.sub];
    if (!customerToken) {
      throw new SeedError(`No token provided for customer ${plan.sub}`);
    }

    // Onboarding: POST /v1/customers/me
    const profileRes = await requestJson<RawCustomerProfileDto>(
      `${baseUrl}/v1/customers/me`,
      'POST',
      customerToken,
      { fullName: plan.fullName },
    );
    const customerId = profileRes.data.id;

    // List existing accounts: GET /v1/accounts
    const accountsListRes = await requestJson<RawAccountDto[]>(
      `${baseUrl}/v1/accounts`,
      'GET',
      customerToken,
    );

    // Sort accounts deterministically: createdAt ASC, id ASC
    const existingAccounts = (accountsListRes.data || []).slice().sort((a, b) => {
      const timeCmp = (a.createdAt || '').localeCompare(b.createdAt || '');
      if (timeCmp !== 0) return timeCmp;
      return a.id.localeCompare(b.id);
    });

    const accountResults: SeedAccountResult[] = [];

    for (const accPlan of plan.accounts) {
      const match = existingAccounts.find(a => a.type === accPlan.type);
      let accountId: string;
      let status: string;
      let reused: boolean;

      if (match) {
        accountId = match.id;
        status = match.status;
        reused = true;
      } else {
        const openRes = await requestJson<RawAccountDto>(
          `${baseUrl}/v1/accounts`,
          'POST',
          customerToken,
          { type: accPlan.type },
        );
        accountId = openRes.data.id;
        status = openRes.data.status;
        reused = false;
        existingAccounts.push(openRes.data);
      }

      const accResult: SeedAccountResult = {
        id: accountId,
        type: accPlan.type,
        status,
        reused,
        finalBalance: '0',
      };
      accountResults.push(accResult);
      accountLookup.set(`${plan.sub}:${accPlan.type}`, accResult);
    }

    customerResults.push({
      sub: plan.sub,
      fullName: plan.fullName,
      customerId,
      accounts: accountResults,
    });
  }

  // BL-213: the fixed Idempotency-Key only protects a re-run until the key row is cleaned up
  // (DBS-136, 7 days by default). So each step first reads the balance through the API and
  // compares it with the balances the plan passes through: a step whose effect is already there
  // is skipped, a balance outside the plan stops the seed before it moves any money.
  const { trails, transferPositions } = planBalanceTrail();
  const readBalance = async (sub: string, accountId: string): Promise<bigint> => {
    const token = tokens.customers[sub];
    if (!token) {
      throw new SeedError(`No token provided for customer ${sub}`);
    }
    const res = await requestJson<RawAccountDto[]>(`${baseUrl}/v1/accounts`, 'GET', token);
    const match = (res.data || []).find(a => a.id === accountId);
    if (!match || match.balance === undefined) {
      throw new SeedError(`Cannot read the balance of account ${accountId} (${sub}) from the API`);
    }
    return BigInt(match.balance);
  };
  const positionOf = (
    what: string,
    sub: string,
    type: string,
    balance: bigint,
  ): { position: number; trail: bigint[] } => {
    const key = accountKey(sub, type);
    const trail = trails.get(key);
    if (!trail) {
      throw new SeedError(`Account ${key} is not part of the demo plan`);
    }
    const position = trail.indexOf(balance);
    if (position < 0) {
      throw divergence(what, key, balance, trail);
    }
    return { position, trail };
  };

  // 2. Operator deposits
  const depositResults: SeedDepositResult[] = [];
  for (const plan of SEED_CUSTOMERS) {
    for (const accPlan of plan.accounts) {
      const acc = accountLookup.get(accountKey(plan.sub, accPlan.type));
      if (!acc) {
        throw new SeedError(`Missing account lookup for ${plan.sub}:${accPlan.type}`);
      }

      const balance = await readBalance(plan.sub, acc.id);
      const { position } = positionOf('the deposit', plan.sub, accPlan.type, balance);
      if (position >= 1) {
        // Balance already past "empty": the deposit (or what followed it) is in the ledger.
        depositResults.push({
          toAccountId: acc.id,
          amount: accPlan.initialDeposit,
          transferId: null,
          status: SEED_STEP_SKIPPED,
          skipped: true,
        });
        continue;
      }

      const depositRes = await requestJson<RawTransferResultDto>(
        `${baseUrl}/v1/operator/deposits`,
        'POST',
        tokens.operator,
        { toAccountId: acc.id, amount: accPlan.initialDeposit },
        accPlan.depositIdempotencyKey,
      );

      depositResults.push({
        toAccountId: acc.id,
        amount: accPlan.initialDeposit,
        transferId: depositRes.data.transferId,
        status: depositRes.data.status,
      });
    }
  }

  // 3. Customer transfers
  const transferResults: SeedTransferResult[] = [];
  for (const [index, txPlan] of SEED_TRANSFERS.entries()) {
    const fromAcc = accountLookup.get(`${txPlan.fromSub}:${txPlan.fromAccountType}`);
    const toAcc = accountLookup.get(`${txPlan.toSub}:${txPlan.toAccountType}`);
    if (!fromAcc) {
      throw new SeedError(
        `Source account not found for transfer: ${txPlan.fromSub}:${txPlan.fromAccountType}`,
      );
    }
    if (!toAcc) {
      throw new SeedError(
        `Destination account not found for transfer: ${txPlan.toSub}:${txPlan.toAccountType}`,
      );
    }

    const senderToken = tokens.customers[txPlan.fromSub];
    if (!senderToken) {
      throw new SeedError(`No token provided for sender customer ${txPlan.fromSub}`);
    }

    const expected = transferPositions[index];
    const label = `transfer #${index + 1}`;
    const from = positionOf(
      label,
      txPlan.fromSub,
      txPlan.fromAccountType,
      await readBalance(txPlan.fromSub, fromAcc.id),
    );
    const to = positionOf(
      label,
      txPlan.toSub,
      txPlan.toAccountType,
      await readBalance(txPlan.toSub, toAcc.id),
    );
    const fromDone = from.position >= expected.from;
    const toDone = to.position >= expected.to;
    if (fromDone !== toDone) {
      throw new SeedError(
        `Seed stopped before ${label}: the sender ${accountKey(txPlan.fromSub, txPlan.fromAccountType)} ` +
          `${fromDone ? 'already shows' : 'does not show'} the transfer but the receiver ` +
          `${accountKey(txPlan.toSub, txPlan.toAccountType)} ${toDone ? 'does' : 'does not'}. ` +
          `The two sides disagree, so the seed will not move money. Rebuild the database and run the seed again.`,
      );
    }
    if (fromDone && toDone) {
      transferResults.push({
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        amount: txPlan.amount,
        transferId: null,
        status: SEED_STEP_SKIPPED,
        skipped: true,
      });
      continue;
    }

    const transferRes = await requestJson<RawTransferResultDto>(
      `${baseUrl}/v1/transfers`,
      'POST',
      senderToken,
      {
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        amount: txPlan.amount,
      },
      txPlan.idempotencyKey,
    );

    transferResults.push({
      fromAccountId: fromAcc.id,
      toAccountId: toAcc.id,
      amount: txPlan.amount,
      transferId: transferRes.data.transferId,
      status: transferRes.data.status,
    });
  }

  // 4. Update final balances
  for (const cust of customerResults) {
    const token = tokens.customers[cust.sub];
    const latestAccounts = await requestJson<RawAccountDto[]>(
      `${baseUrl}/v1/accounts`,
      'GET',
      token,
    );
    for (const acc of cust.accounts) {
      const match = latestAccounts.data.find(a => a.id === acc.id);
      if (match && match.balance !== undefined) {
        acc.finalBalance = String(match.balance);
      }
    }
  }

  return {
    baseUrl,
    customers: customerResults,
    deposits: depositResults,
    transfers: transferResults,
  };
}

export interface SeedCliIo {
  nodeEnv?: string;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface ParsedCliArgs {
  help: boolean;
  baseUrl: string;
  authMode: 'local' | 'cloud';
  keyDir?: string;
  operatorToken?: string;
  customer1Token?: string;
  customer2Token?: string;
  customer3Token?: string;
  quiet: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let help = false;
  let quiet = false;
  let baseUrl = process.env.DBS_API_URL || process.env.API_URL || 'http://127.0.0.1:3000';
  let authMode: 'local' | 'cloud' =
    process.env.AUTH_MODE === 'cognito' || process.env.AUTH_MODE === 'cloud' ? 'cloud' : 'local';
  let keyDir: string | undefined;
  let operatorToken: string | undefined;
  let customer1Token: string | undefined;
  let customer2Token: string | undefined;
  let customer3Token: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--url') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new SeedError('--url requires a URL parameter');
      baseUrl = val;
    } else if (arg === '--auth') {
      const val = argv[++i];
      if (val !== 'local' && val !== 'cloud') {
        throw new SeedError('--auth must be "local" or "cloud"');
      }
      authMode = val;
    } else if (arg === '--key-dir') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new SeedError('--key-dir requires a directory path');
      keyDir = val;
    } else if (arg === '--operator-token') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new SeedError('--operator-token requires a token');
      operatorToken = val;
    } else if (arg === '--customer1-token') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new SeedError('--customer1-token requires a token');
      customer1Token = val;
    } else if (arg === '--customer2-token') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new SeedError('--customer2-token requires a token');
      customer2Token = val;
    } else if (arg === '--customer3-token') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new SeedError('--customer3-token requires a token');
      customer3Token = val;
    } else {
      throw new SeedError(`Unknown CLI argument: ${arg}`);
    }
  }

  return {
    help,
    baseUrl,
    authMode,
    keyDir,
    operatorToken,
    customer1Token,
    customer2Token,
    customer3Token,
    quiet,
  };
}

export function printHelp(): string {
  return [
    'Digital Banking Simulator — Demo Data Seed Script (DBS-70)',
    '',
    'Usage: npm run seed -- [options]',
    '',
    'Options:',
    '  --url <url>              API base URL (default: http://127.0.0.1:3000 or DBS_API_URL)',
    '  --auth <local|cloud>     Authentication mode: local | cloud (default: local)',
    '  --key-dir <path>         Local JWT signing key directory (default: .auth-local)',
    '  --operator-token <jwt>   Operator access token (required for cloud auth)',
    '  --customer1-token <jwt>  Customer 1 token (Nguyễn Minh Anh, required for cloud)',
    '  --customer2-token <jwt>  Customer 2 token (Trần Thu Hà, required for cloud)',
    '  --customer3-token <jwt>  Customer 3 token (Nguyễn Văn Bình, required for cloud)',
    '  --quiet, -q              Suppress summary output on success',
    '  --help, -h               Show this help message',
    '',
    'Environment variables:',
    '  DBS_API_URL / API_URL    Default API base URL',
    '  AUTH_MODE                Set to "local" or "cognito" (mapped to cloud)',
    '  DBS_OPERATOR_TOKEN       Operator token for cloud auth',
    '  DBS_CUSTOMER_1_TOKEN     Customer 1 token for cloud auth',
    '  DBS_CUSTOMER_2_TOKEN     Customer 2 token for cloud auth',
    '  DBS_CUSTOMER_3_TOKEN     Customer 3 token for cloud auth',
    '',
  ].join('\n');
}

export function formatReport(report: SeedReport): string {
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push('Digital Banking Simulator — Demo Seed Complete (DBS-70)');
  lines.push(`API Base URL: ${report.baseUrl}`);
  lines.push('============================================================');
  lines.push('');
  lines.push('CUSTOMERS & ACCOUNTS:');

  for (const c of report.customers) {
    lines.push(`• ${c.fullName} (${c.sub})`);
    lines.push(`  Customer ID: ${c.customerId}`);
    for (const a of c.accounts) {
      const state = a.reused ? 'Reused' : 'Created';
      const formattedBalance = `${Number(a.finalBalance).toLocaleString('vi-VN')} VND`;
      lines.push(`  - [${a.type}] ${a.id} (${state}, Balance: ${formattedBalance})`);
    }
  }

  lines.push('');
  lines.push(`OPERATOR DEPOSITS (${report.deposits.length} transactions):`);
  for (const d of report.deposits) {
    const amountStr = `${Number(d.amount).toLocaleString('vi-VN')} VND`;
    const tx = d.skipped ? 'skipped (balance already reflects it)' : d.transferId;
    lines.push(`• Target: ${d.toAccountId} | Amount: ${amountStr} | Tx: ${tx}`);
  }

  lines.push('');
  lines.push(`CUSTOMER TRANSFERS (${report.transfers.length} transactions):`);
  for (const t of report.transfers) {
    const amountStr = `${Number(t.amount).toLocaleString('vi-VN')} VND`;
    const note = t.skipped ? ' | skipped (balance already reflects it)' : '';
    lines.push(`• From: ${t.fromAccountId} -> To: ${t.toAccountId} | Amount: ${amountStr}${note}`);
  }

  lines.push('');
  lines.push(
    'Re-run safe: each deposit/transfer is sent only when the API balance shows it has not happened yet, so it holds even after the Idempotency-Key rows were cleaned up.',
  );
  lines.push('Ledger invariant: System funding covers all deposits; total ledger balance = 0.');
  lines.push('============================================================');
  return lines.join('\n');
}

export async function runSeedCli(argv: string[], io?: SeedCliIo): Promise<number> {
  const stdout = io?.stdout ?? (text => process.stdout.write(text));
  const stderr = io?.stderr ?? (text => process.stderr.write(text));
  const cwd = io?.cwd ?? process.cwd();

  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      stdout(`${printHelp()}\n`);
      return 0;
    }

    const report = await runSeed(
      {
        baseUrl: args.baseUrl,
        authMode: args.authMode,
        keyDir: args.keyDir ? resolve(cwd, args.keyDir) : undefined,
        quiet: args.quiet,
      },
      {
        operatorToken: args.operatorToken,
        customer1Token: args.customer1Token,
        customer2Token: args.customer2Token,
        customer3Token: args.customer3Token,
      },
    );

    if (!args.quiet) {
      stdout(`${formatReport(report)}\n`);
    }
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    stderr(`Error: ${msg}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runSeedCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
