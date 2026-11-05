import type { EntityManager } from 'typeorm';
import type { TransactionService } from '@database/transaction.service';
import { AuditSearchService } from './audit-search.service';
import { AuditService } from './audit.service';
import { parseAuditSearchQuery } from './audit-search.query';

const CALLER = {
  userId: '33333333-3333-4333-8333-333333333333',
  correlationId: '44444444-4444-4444-8444-444444444444',
};
const row = (id: string) => ({
  id,
  occurredAt: '2026-11-04T08:10:00.123456Z',
  actorUserId: null,
  actorRole: 'system',
  action: 'audit.fixture',
  outcome: 'SUCCESS',
  targetType: 'fixture',
  targetId: 'source',
  correlationId: '55555555-5555-4555-8555-555555555555',
  metadata: {},
});

describe('AuditSearchService transaction orchestration (DBS-103)', () => {
  it('TC-103-10/11 records first, uses the same manager and waits for commit', async () => {
    const order: string[] = [];
    let commit!: () => void;
    let atCommit!: () => void;
    const commitGate = new Promise<void>(resolve => {
      commit = resolve;
    });
    const reachedCommit = new Promise<void>(resolve => {
      atCommit = resolve;
    });
    const query = jest.fn().mockImplementation(() => {
      order.push('select');
      return Promise.resolve([row('9007199254740993')]);
    });
    const manager = { query } as unknown as EntityManager;
    const tx = {
      run: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => {
        const page = await fn(manager);
        atCommit();
        await commitGate;
        order.push('commit');
        return page;
      }),
    } as unknown as TransactionService;
    const record = jest.fn().mockImplementation(() => {
      order.push('record');
      return Promise.resolve();
    });
    const audit = { record } as unknown as AuditService;
    const service = new AuditSearchService(tx, audit);
    let published = false;
    const result = service.search(parseAuditSearchQuery({}), CALLER).then(page => {
      published = true;
      return page;
    });
    await reachedCommit;
    expect(published).toBe(false);
    expect(order).toEqual(['record', 'select']);
    expect(record).toHaveBeenCalledWith(manager, {
      actor: CALLER.userId,
      role: 'auditor',
      action: 'audit.search',
      outcome: 'SUCCESS',
      target: { type: 'audit_search', id: CALLER.correlationId },
      correlationId: CALLER.correlationId,
      metadata: {},
    });
    commit();
    expect(await result).toEqual({
      entries: [
        {
          id: '9007199254740993',
          occurredAt: '2026-11-04T08:10:00.123456Z',
          actorUserId: null,
          actorRole: 'system',
          action: 'audit.fixture',
          outcome: 'SUCCESS',
          target: { type: 'fixture', id: 'source' },
          correlationId: row('x').correlationId,
          metadata: {},
        },
      ],
      nextCursor: null,
    });
    expect(order).toEqual(['record', 'select', 'commit']);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  it('TC-103-08 uses the last returned row rather than the limit+1 sentinel', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValue([row('10000000000000000'), row('9999999999999999'), row('10')]),
    } as unknown as EntityManager;
    const tx = {
      run: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as TransactionService;
    const service = new AuditSearchService(tx, {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);
    const page = await service.search(parseAuditSearchQuery({ limit: '2' }), CALLER);
    expect(page.entries.map(entry => entry.id)).toEqual(['10000000000000000', '9999999999999999']);
    expect(parseAuditSearchQuery({ cursor: page.nextCursor }).cursor?.id).toBe('9999999999999999');
  });

  it('TC-103-11 never SELECTs or publishes entries if recording fails', async () => {
    const original = Object.assign(new Error('private database detail'), { code: '55P03' });
    const manager = { query: jest.fn() } as unknown as EntityManager;
    const tx = {
      run: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as TransactionService;
    const service = new AuditSearchService(tx, {
      record: jest.fn().mockRejectedValue(original),
    } as unknown as AuditService);
    await expect(service.search(parseAuditSearchQuery({}), CALLER)).rejects.toBe(original);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('TC-103-12 preserves a SELECT failure for transaction rollback', async () => {
    const original = Object.assign(new Error('select refused'), { code: '42501' });
    const manager = { query: jest.fn().mockRejectedValue(original) } as unknown as EntityManager;
    const tx = {
      run: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as TransactionService;
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new AuditSearchService(tx, { record } as unknown as AuditService);
    await expect(
      service.search(parseAuditSearchQuery({ action: 'private-action-probe' }), CALLER),
    ).rejects.toBe(original);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1].metadata).toEqual({});
    expect(JSON.stringify(record.mock.calls)).not.toContain('private-action-probe');
  });

  it('TC-103-05 audits an empty valid lookup as a successful search', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) } as unknown as EntityManager;
    const tx = {
      run: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as TransactionService;
    const record = jest.fn().mockResolvedValue(undefined);
    const service = new AuditSearchService(tx, { record } as unknown as AuditService);
    await expect(
      service.search(
        parseAuditSearchQuery({ correlationId: '55555555-5555-4555-8555-555555555555' }),
        CALLER,
      ),
    ).resolves.toEqual({ entries: [], nextCursor: null });
    expect(record).toHaveBeenCalledTimes(1);
  });
});
