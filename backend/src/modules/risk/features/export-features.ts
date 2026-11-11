import { readFileSync, writeFileSync } from 'node:fs';
import type { FeatureInput } from '../ai/ai-contract';
import type { TransferEvent } from './feature-provider';
import { OfflineFeatureProvider, type OfflineTransferFact } from './offline-feature-provider';

export const OUTPUT_HEADERS = [
  'tx_id',
  'amount',
  'fromBalanceBefore',
  'accountAgeHours',
  'sameOwner',
  'txCount10m',
  'txCount1h',
  'historyCount30d',
  'medianAmount30d',
  'minutesSinceReverse',
  'newRecipients1h',
  'distinctRecipients24h',
  'is_fraud',
] as const;

export const EXPECTED_INPUT_COLUMNS = [
  'tx_id',
  'occurred_at',
  'from_account',
  'to_account',
  'from_customer',
  'to_customer',
  'amount',
  'from_balance_before',
  'from_account_created_at',
  'to_account_created_at',
  'is_fraud',
  'scenario',
] as const;

export interface ParsedDataset {
  readonly facts: OfflineTransferFact[];
  readonly events: TransferEvent[];
  readonly labels: Map<string, string>;
}

export function parseTransactionCsv(csvText: string): ParsedDataset {
  // Keep the physical line number of every non-blank line, so an error can name the line to fix.
  const lines = csvText
    .split(/\r?\n/)
    .map((text, index) => ({ text, number: index + 1 }))
    .filter(line => line.text.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('Empty CSV file');
  }

  const header = lines[0].text.split(',').map(s => s.trim());
  const indexMap = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    indexMap.set(header[i], i);
  }

  for (const required of EXPECTED_INPUT_COLUMNS) {
    if (!indexMap.has(required)) {
      throw new Error(`Invalid CSV header: missing required column '${required}'`);
    }
  }

  const txIdIdx = indexMap.get('tx_id')!;
  const occurredAtIdx = indexMap.get('occurred_at')!;
  const fromAccIdx = indexMap.get('from_account')!;
  const toAccIdx = indexMap.get('to_account')!;
  const fromCustIdx = indexMap.get('from_customer')!;
  const toCustIdx = indexMap.get('to_customer')!;
  const amountIdx = indexMap.get('amount')!;
  const balanceIdx = indexMap.get('from_balance_before')!;
  const fromCreatedAtIdx = indexMap.get('from_account_created_at')!;
  const toCreatedAtIdx = indexMap.get('to_account_created_at')!;
  const isFraudIdx = indexMap.get('is_fraud')!;

  const facts: OfflineTransferFact[] = [];
  const events: TransferEvent[] = [];
  const labels = new Map<string, string>();

  for (let i = 1; i < lines.length; i++) {
    const { text, number } = lines[i];
    // The tune CSV has no quoting or embedded commas: refuse anything else instead of mis-splitting.
    if (text.includes('"')) throw new Error(`Line ${number}: quoted fields are not supported`);
    const cols = text.split(',').map(s => s.trim());
    if (cols.length !== header.length) {
      throw new Error(`Line ${number}: expected ${header.length} columns, got ${cols.length}`);
    }

    const txId = cols[txIdIdx];
    const occurredAt = cols[occurredAtIdx];
    const fromAccount = cols[fromAccIdx];
    const toAccount = cols[toAccIdx];
    const fromCustomer = cols[fromCustIdx];
    const toCustomer = cols[toCustIdx];
    const amount = cols[amountIdx];
    const fromBalanceBefore = cols[balanceIdx];
    const fromAccountCreatedAt = cols[fromCreatedAtIdx];
    const toAccountCreatedAt = cols[toCreatedAtIdx];
    const isFraud = cols[isFraudIdx];
    if (isFraud !== '0' && isFraud !== '1') {
      throw new Error(`Line ${number}: is_fraud must be 0 or 1, got '${isFraud}'`);
    }

    facts.push({
      id: txId,
      fromAccountId: fromAccount,
      toAccountId: toAccount,
      createdAt: occurredAt,
      amount,
    });

    events.push({
      eventType: 'TransferCompleted',
      eventId: txId,
      correlationId: `export-${txId}`,
      transferId: txId,
      fromAccountId: fromAccount,
      toAccountId: toAccount,
      fromUserId: fromCustomer,
      toUserId: toCustomer,
      type: 'TRANSFER',
      amount,
      fromBalanceBefore,
      sameOwner: fromCustomer === toCustomer,
      occurredAt,
      fromAccountCreatedAt,
      toAccountCreatedAt,
    });

    labels.set(txId, isFraud);
  }

  return { facts, events, labels };
}

/**
 * Only `smallTxCount24h` of the provider reads this limit, and that field is not among the 11 exported
 * fields, so its value never changes the output. It is NOT the platform limit (TRANSFER_LIMIT_PER_TX).
 */
const OFFLINE_PER_TX_LIMIT = 500_000_000n;

export async function exportFeaturesString(
  csvText: string,
  perTxLimit: bigint = OFFLINE_PER_TX_LIMIT,
): Promise<string> {
  const { facts, events, labels } = parseTransactionCsv(csvText);
  const provider = new OfflineFeatureProvider(facts, perTxLimit);

  const outLines: string[] = [OUTPUT_HEADERS.join(',')];

  for (const event of events) {
    const aiInput: FeatureInput = await provider.extractAiInput(event);
    const row = [
      event.transferId,
      aiInput.amount,
      aiInput.fromBalanceBefore,
      String(aiInput.accountAgeHours),
      String(aiInput.sameOwner),
      String(aiInput.txCount10m),
      String(aiInput.txCount1h),
      String(aiInput.historyCount30d),
      aiInput.medianAmount30d ?? '',
      aiInput.minutesSinceReverse !== null ? String(aiInput.minutesSinceReverse) : '',
      String(aiInput.newRecipients1h),
      String(aiInput.distinctRecipients24h),
      labels.get(event.transferId) ?? '0',
    ];
    outLines.push(row.join(','));
  }

  return outLines.join('\n') + '\n';
}

export async function exportFeaturesFile(
  inputPath: string,
  outputPath: string,
  perTxLimit: bigint = OFFLINE_PER_TX_LIMIT,
): Promise<{ rowCount: number }> {
  const text = readFileSync(inputPath, 'utf8');
  const result = await exportFeaturesString(text, perTxLimit);
  writeFileSync(outputPath, result, 'utf8');
  const lines = result.trim().split('\n');
  return { rowCount: lines.length - 1 };
}
