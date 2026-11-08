import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';
import { checkLedgerInvariants } from '../support/invariants';

type App = Awaited<ReturnType<typeof startDepositApp>>;
interface Item {
  id: string;
  type: string;
  status: string;
  ownerName: string;
}
const FUNDING = '00000000-0000-4000-8000-000000000001';
const KEYS = ['id', 'ownerName', 'status', 'type'];
const ACTION = 'operator.account.search';

/** DBS-88 FR-ACC-04: an operator finds customer accounts without seeing a balance. */
describe('DBS-88 operator account search', () => {
  let db: TempDatabase, app: App, operatorId: string, operator: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const as = (token: string, term?: string, extra = '') =>
    request(app.url)
      .get(
        `/v1/operator/accounts${term === undefined ? '' : `?q=${encodeURIComponent(term)}`}${extra}`,
      )
      .auth(token, { type: 'bearer' });
  const search = (term: string) => as(operator, term);
  /** A customer with `name`, one account (CHECKING), optionally a second and a status. */
  async function customer(name: string, options: { second?: boolean; locked?: boolean } = {}) {
    const row = await seedDepositTarget(db.runner, options.locked ? 'LOCKED' : 'ACTIVE');
    await q('UPDATE customers SET full_name=$2 WHERE id=$1', [row.customerId, name]);
    let second: string | undefined;
    if (options.second) {
      second = randomUUID();
      await q("INSERT INTO accounts(id,customer_id,type,status) VALUES($1,$2,'SAVINGS','ACTIVE')", [
        second,
        row.customerId,
      ]);
    }
    return { ...row, second };
  }
  const names = (items: Item[]) => items.map(i => i.ownerName);

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    operator = await app.issuer.token('operator', { sub: randomUUID() });
    // The first call upserts the operator's users row; read its id for the audit assertions.
    await search('zzz-warm-up').expect(200);
    const [row] = await q(
      'SELECT actor_user_id FROM audit_log WHERE action=$1 ORDER BY id DESC LIMIT 1',
      [ACTION],
    );
    operatorId = row.actor_user_id as string;
  });
  afterEach(async () => {
    const result = await checkLedgerInvariants(db.runner);
    expect(result.status).toBe('PASS');
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-88-01 finds one account by its id, with four fields and no balance', async () => {
    const minhAnh = await customer('Trần Hoài Phương');
    await request(app.url)
      .post('/v1/operator/deposits')
      .auth(operator, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ toAccountId: minhAnh.accountId, amount: '5000000' })
      .expect(201);
    for (const term of [
      minhAnh.accountId,
      minhAnh.accountId.toUpperCase(),
      ` ${minhAnh.accountId} `,
    ]) {
      const res = await search(term).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        items: [
          {
            id: minhAnh.accountId,
            type: 'CHECKING',
            status: 'ACTIVE',
            ownerName: 'Trần Hoài Phương',
          },
        ],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/balance|5000000/i);
    }
  });

  it('TC-88-02 finds by part of the owner name, any case, locked accounts and second accounts included', async () => {
    const prefix = 'Lương ';
    const a = await customer(`${prefix}Minh Anh`, { second: true });
    const b = await customer(`${prefix}Văn Bình`, { locked: true });
    await customer('Phạm Thu Hà');
    // Case differs only in ASCII letters: how a database folds the case of "Ư" or "Ơ" depends on the
    // locale of the server, not on this code.
    for (const [term, expected] of [
      ['lương', [a.accountId, a.second!, b.accountId]],
      ['minh anh', [a.accountId, a.second!]],
      ['MINH ANH', [a.accountId, a.second!]],
      ['Lương Minh', [a.accountId, a.second!]],
      ['Văn Bình', [b.accountId]],
      ['ình', [b.accountId]],
    ] as [string, string[]][]) {
      const res = await search(term).expect(200);
      expect({ term, ids: (res.body.items as Item[]).map(i => i.id).sort() }).toEqual({
        term,
        ids: [...expected].sort(),
      });
    }
    const lương = (await search('lương').expect(200)).body.items as Item[];
    expect(lương.map(i => i.id).sort()).toEqual([a.accountId, a.second!, b.accountId].sort());
    expect(lương.find(i => i.id === b.accountId)).toMatchObject({ status: 'LOCKED' });
    expect(lương.find(i => i.id === a.second)).toMatchObject({ type: 'SAVINGS' });
    for (const item of lương) expect(Object.keys(item).sort()).toEqual(KEYS);
    expect(names((await search('Phạm Thu').expect(200)).body.items)).toEqual(['Phạm Thu Hà']);
    expect((await search('Không Có Ai').expect(200)).body).toEqual({ items: [] });
  });

  it('TC-88-03 returns at most 20 accounts in a stable order', async () => {
    const base = 'Đoàn Test';
    for (let i = 0; i < 25; i++) await customer(`${base} ${String(i).padStart(2, '0')}`);
    const first = (await search(base).expect(200)).body.items as Item[];
    expect(first).toHaveLength(20);
    expect(names(first)).toEqual(
      Array.from({ length: 20 }, (_, i) => `${base} ${String(i).padStart(2, '0')}`),
    );
    expect(names((await search(base).expect(200)).body.items)).toEqual(names(first));
  });

  it('TC-88-04 never shows the funding account', async () => {
    expect((await search(FUNDING).expect(200)).body).toEqual({ items: [] });
    expect((await search('funding').expect(200)).body).toEqual({ items: [] });
  });

  it('TC-88-05 % _ and \\ are plain characters, never wildcards', async () => {
    await customer('Giảm 50% Phí');
    await customer('Giảm 50 Phí');
    await customer('Lê_Hoa');
    await customer('Lê Hoa');
    await customer('Đường\\Ngang');
    expect(names((await search('50%').expect(200)).body.items)).toEqual(['Giảm 50% Phí']);
    expect(names((await search('Lê_').expect(200)).body.items)).toEqual(['Lê_Hoa']);
    expect(names((await search('\\Ngang').expect(200)).body.items)).toEqual(['Đường\\Ngang']);
    expect((await search('%').expect(200)).body.items.map((i: Item) => i.ownerName)).toEqual([
      'Giảm 50% Phí',
    ]);
    expect(names((await search('_').expect(200)).body.items)).toEqual(['Lê_Hoa']);
  });

  it('TC-88-06 rejects a missing, blank, long or unclean term with 400', async () => {
    const before = (
      await q('SELECT count(*)::int AS n FROM audit_log WHERE action=$1', [ACTION])
    )[0].n;
    for (const target of [
      '/v1/operator/accounts',
      '/v1/operator/accounts?q=',
      '/v1/operator/accounts?q=%20%20%20',
      `/v1/operator/accounts?q=${'a'.repeat(101)}`,
      '/v1/operator/accounts?q=a%00b',
      '/v1/operator/accounts?q=a%0Ab',
      '/v1/operator/accounts?q=a&q=b',
      '/v1/operator/accounts?q=a&limit=5',
      '/v1/operator/accounts?name=a',
    ]) {
      const res = await request(app.url).get(target).auth(operator, { type: 'bearer' });
      expect({ target, status: res.status }).toEqual({ target, status: 400 });
    }
    // A refused request is not a lookup: it leaves no audit row.
    const after = (await q('SELECT count(*)::int AS n FROM audit_log WHERE action=$1', [ACTION]))[0]
      .n;
    expect(after).toBe(before);
  });

  it('TC-88-07 every lookup is audited: who, how many, and the id or a fingerprint, never the name', async () => {
    const target = await customer('Võ Thị Sáu');
    const byId = await search(target.accountId).expect(200);
    const byName = await search('Võ Thị').expect(200);
    const nobody = await search('Không Tồn Tại Tên').expect(200);
    const rows = async (res: request.Response): Promise<Record<string, unknown>[]> => {
      const found: Record<string, unknown>[] = await q(
        'SELECT actor_user_id,actor_role,outcome,target_type,target_id,metadata FROM audit_log WHERE action=$1 AND correlation_id=$2',
        [ACTION, res.headers['x-correlation-id']],
      );
      return found;
    };
    const fingerprint = (term: string) =>
      createHash('sha256').update(term.toLowerCase()).digest('hex').slice(0, 32);
    expect(await rows(byId)).toEqual([
      {
        actor_user_id: operatorId,
        actor_role: 'operator',
        outcome: 'SUCCESS',
        target_type: 'account',
        target_id: target.accountId,
        metadata: { count: 1 },
      },
    ]);
    const [name] = await rows(byName);
    expect(name).toMatchObject({
      actor_user_id: operatorId,
      outcome: 'SUCCESS',
      target_type: 'account_search',
      target_id: fingerprint('Võ Thị'),
      metadata: { count: byName.body.items.length },
    });
    const [empty] = await rows(nobody);
    expect(empty).toMatchObject({
      metadata: { count: 0 },
      target_id: fingerprint('Không Tồn Tại Tên'),
    });
    // The log holds no customer name anywhere.
    const all = JSON.stringify(await q('SELECT * FROM audit_log WHERE action=$1', [ACTION]));
    expect(all).not.toMatch(/Võ|Sáu|Tồn Tại/);
  });

  it('TC-88-08 no audit, no data', async () => {
    await customer('Hồ Xuân Hương');
    await q(
      "CREATE FUNCTION dbs88_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs88_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs88_fail_audit()',
    );
    try {
      const failed = await search('Hồ Xuân').expect(500);
      expect(JSON.stringify(failed.body)).not.toMatch(
        /Hồ|Hương|audit unavailable|SELECT|ownerName/,
      );
    } finally {
      await q('DROP TRIGGER dbs88_fail_audit ON audit_log');
      await q('DROP FUNCTION dbs88_fail_audit()');
    }
    expect(names((await search('Hồ Xuân').expect(200)).body.items)).toEqual(['Hồ Xuân Hương']);
  });

  it('TC-88-09 customers.full_name has no index (the decision of database-design §6.2)', async () => {
    const indexes: { indexdef: string }[] = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='customers'",
    );
    expect(indexes.map(i => i.indexdef).filter(def => /full_name/i.test(def))).toEqual([]);
  });

  it('TC-88-10 only an operator: customer, auditor and admin get 403 and leave no lookup behind', async () => {
    const before = (
      await q('SELECT count(*)::int AS n FROM audit_log WHERE action=$1', [ACTION])
    )[0].n;
    for (const role of ['customer', 'auditor', 'admin'] as const) {
      const jwt = await app.issuer.token(role, { sub: randomUUID() });
      const res = await as(jwt, 'a');
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
      expect(JSON.stringify(res.body)).not.toMatch(/ownerName/);
    }
    await request(app.url).get('/v1/operator/accounts?q=a').expect(401);
    const after = (await q('SELECT count(*)::int AS n FROM audit_log WHERE action=$1', [ACTION]))[0]
      .n;
    expect(after).toBe(before);
  });

  it('TC-88-12 Swagger documents the role, the parameter and the errors', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    const route = doc.paths['/v1/operator/accounts'].get!;
    expect(route.security).toContainEqual({ 'access-token': [] });
    expect(
      (route.parameters as { name: string; required: boolean }[]).map(p => [p.name, p.required]),
    ).toEqual([['q', true]]);
    for (const status of ['200', '400', '401', '403', '500', '503'])
      expect(route.responses[status]).toBeDefined();
    expect(JSON.stringify(doc.components!.schemas!.OperatorAccountDto)).not.toMatch(/balance/i);
  });
});
