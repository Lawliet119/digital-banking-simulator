import { createHash } from 'node:crypto';
import { exportFeaturesString, parseTransactionCsv } from './export-features';

const SAMPLE_CSV = `tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario
00000000-0000-4000-8000-000000000001,2026-10-01T10:00:00.000Z,acc-1,acc-2,cust-1,cust-2,100000,500000,2026-09-01T00:00:00.000Z,2026-09-01T00:00:00.000Z,0,NORMAL
00000000-0000-4000-8000-000000000002,2026-10-01T10:05:00.000Z,acc-1,acc-3,cust-1,cust-3,200000,400000,2026-09-01T00:00:00.000Z,2026-09-01T00:00:00.000Z,1,ATO_DRAIN
`;

describe('DBS-211 export-features', () => {
  it('TC-211-01 outputs exactly 13 columns matching FeatureInput and is_fraud, omitting scenario', async () => {
    const result = await exportFeaturesString(SAMPLE_CSV);
    const lines = result.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows

    const header = lines[0].split(',');
    expect(header).toEqual([
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
    ]);
    expect(header).not.toContain('scenario');

    // First transaction row
    const row1 = lines[1].split(',');
    expect(row1).toHaveLength(13);
    expect(row1[0]).toBe('00000000-0000-4000-8000-000000000001');
    expect(row1[1]).toBe('100000'); // amount
    expect(row1[2]).toBe('500000'); // fromBalanceBefore
    expect(row1[4]).toBe('false'); // sameOwner
    expect(row1[12]).toBe('0'); // is_fraud

    // Second transaction row
    const row2 = lines[2].split(',');
    expect(row2).toHaveLength(13);
    expect(row2[0]).toBe('00000000-0000-4000-8000-000000000002');
    expect(row2[1]).toBe('200000'); // amount
    expect(row2[12]).toBe('1'); // is_fraud
  });

  it('TC-211-02 causal integrity: future transactions never alter past features', async () => {
    const baseOutput = await exportFeaturesString(SAMPLE_CSV);
    const futureCsv =
      SAMPLE_CSV +
      `00000000-0000-4000-8000-000000000003,2026-10-01T12:00:00.000Z,acc-1,acc-4,cust-1,cust-4,300000,200000,2026-09-01T00:00:00.000Z,2026-09-01T00:00:00.000Z,0,NORMAL
`;
    const extendedOutput = await exportFeaturesString(futureCsv);

    const baseLines = baseOutput.trim().split('\n');
    const extendedLines = extendedOutput.trim().split('\n');

    expect(extendedLines[0]).toBe(baseLines[0]); // Header matches
    expect(extendedLines[1]).toBe(baseLines[1]); // Row 1 identical
    expect(extendedLines[2]).toBe(baseLines[2]); // Row 2 identical
    expect(extendedLines).toHaveLength(4); // 3 transactions + header
  });

  it('TC-211-03 hand-computes all 11 fields on a dedicated multi-window sequence', async () => {
    // Construct a rich history:
    // acc-A account created at 2026-10-01T00:00:00Z
    // Transfer 1 at 10:00:00: acc-A -> acc-B (sameOwner = true)
    // Transfer 2 (reverse) at 10:15:00: acc-B -> acc-A
    // Transfer 3 at 10:30:00: acc-A -> acc-B (reverse occurred 15 min ago)
    const handCsv = `tx_id,occurred_at,from_account,to_account,from_customer,to_customer,amount,from_balance_before,from_account_created_at,to_account_created_at,is_fraud,scenario
tx-1,2026-10-01T10:00:00.000Z,acc-A,acc-B,user-1,user-1,50000,1000000,2026-10-01T00:00:00.000Z,2026-10-01T00:00:00.000Z,0,NORMAL
tx-2,2026-10-01T10:15:00.000Z,acc-B,acc-A,user-1,user-1,50000,50000,2026-10-01T00:00:00.000Z,2026-10-01T00:00:00.000Z,0,HN_SELF_TRANSFER
tx-3,2026-10-01T10:30:00.000Z,acc-A,acc-B,user-1,user-1,100000,950000,2026-10-01T00:00:00.000Z,2026-10-01T00:00:00.000Z,0,NORMAL
`;
    const result = await exportFeaturesString(handCsv);
    const lines = result.trim().split('\n');
    const row3 = lines[3].split(',');

    // For tx-3:
    // tx_id = tx-3
    expect(row3[0]).toBe('tx-3');
    // amount = 100000
    expect(row3[1]).toBe('100000');
    // fromBalanceBefore = 950000
    expect(row3[2]).toBe('950000');
    // accountAgeHours: from 00:00 to 10:30 is 10.5h
    expect(Number(row3[3])).toBeCloseTo(10.5, 1);
    // sameOwner: user-1 === user-1 -> true
    expect(row3[4]).toBe('true');
    // txCount10m: only tx-3 itself in [10:20, 10:30]
    expect(row3[5]).toBe('1');
    // txCount1h: tx-1 (10:00) and tx-3 (10:30) are from acc-A within 1h -> 2
    expect(row3[6]).toBe('2');
    // historyCount30d: prior transfers from acc-A is 1 (tx-1)
    expect(row3[7]).toBe('1');
    // medianAmount30d: historyCount < 5 -> null -> ""
    expect(row3[8]).toBe('');
    // minutesSinceReverse: reverse from acc-B occurred at 10:15, so 15 minutes ago
    expect(Number(row3[9])).toBeCloseTo(15, 0);
    // newRecipients1h: acc-B was introduced as novel at 10:00, which is within 1h of 10:30 -> 1
    expect(row3[10]).toBe('1');
    // distinctRecipients24h: acc-B only -> 1
    expect(row3[11]).toBe('1');
    // is_fraud: 0
    expect(row3[12]).toBe('0');
  });

  it('TC-211-04 determinism: running twice on the same input yields identical byte output', async () => {
    const run1 = await exportFeaturesString(SAMPLE_CSV);
    const run2 = await exportFeaturesString(SAMPLE_CSV);

    const hash1 = createHash('sha256').update(run1).digest('hex');
    const hash2 = createHash('sha256').update(run2).digest('hex');

    expect(hash1).toBe(hash2);
    expect(run1).toBe(run2);
  });

  it('TC-211-05 rejects malformed CSVs with missing required columns', () => {
    const badCsv = `tx_id,occurred_at,from_account\n1,2,3`;
    expect(() => parseTransactionCsv(badCsv)).toThrow(/Invalid CSV header/);
  });
});
