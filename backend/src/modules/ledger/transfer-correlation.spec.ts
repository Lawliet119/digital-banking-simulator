import type { EntityManager } from 'typeorm';
import { transferCorrelationId } from './transfer-correlation';

const manager = (rows: unknown[]) => {
  const query = jest.fn().mockResolvedValue(rows);
  return { query, manager: { query } as unknown as EntityManager };
};

describe('transferCorrelationId (DBS-135)', () => {
  it('TC-135-11 returns the correlation id of the transfer, read by primary key with a parameter', async () => {
    const code = '9b4e7c21-5a0d-4f83-b6e9-1d2c8a7f3045';
    const { query, manager: m } = manager([{ correlationId: code }]);
    const transferId = '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44';
    await expect(transferCorrelationId(m, transferId)).resolves.toBe(code);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM transfers\s+WHERE id = \$1/);
    expect(params).toEqual([transferId]);
  });

  it('TC-135-11 returns undefined when there is no such transfer', async () => {
    const { manager: m } = manager([]);
    await expect(transferCorrelationId(m, randomId())).resolves.toBeUndefined();
  });
});

function randomId(): string {
  return '7a2d1c90-0b3e-4f6a-9d85-3e4c5b6a7f10';
}
