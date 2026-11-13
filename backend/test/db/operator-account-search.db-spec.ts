import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { buildSearchSql, parseSearchQuery } from '@modules/accounts/operator-account-search.query';
import { EnableUnaccentSearch1795000008000 } from '../../src/database/migrations/1795000008000-EnableUnaccentSearch';
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
  const API_PASSWORD = 'search-test-only';
  let db: TempDatabase, app: App, operatorId: string, operator: string;
  /** The real dbs_api LOGIN role: proves the grants cover unaccent, not just the owner's rights. */
  let api: DataSource;
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
    await q(`ALTER ROLE dbs_api LOGIN PASSWORD '${API_PASSWORD}'`);
    const apiUrl = new URL(db.url);
    apiUrl.username = 'dbs_api';
    apiUrl.password = API_PASSWORD;
    api = await new DataSource({ type: 'postgres', url: apiUrl.toString() }).initialize();
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
      await api?.destroy();
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
    // Case of accented letters (Ư/ư, Ơ/ơ) is covered by TC-88-14 and TC-88-20: the query folds
    // accents first, so the result does not depend on the locale of the server (BL-178).
    for (const [term, expected] of [
      ['lương', [a.accountId, a.second!, b.accountId]],
      ['minh anh', [a.accountId, a.second!]],
      ['MINH ANH', [a.accountId, a.second!]],
      ['Lương Minh', [a.accountId, a.second!]],
      ['Văn Bình', [b.accountId]],
      ['bình', [b.accountId]],
      // Accent-insensitive since BL-178: «ình» is «inh», which «Minh» contains as well.
      ['ình', [a.accountId, a.second!, b.accountId]],
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

  /** Owner names found by a name term through the HTTP route, as operator. */
  const found = async (term: string): Promise<string[]> =>
    names((await search(term).expect(200)).body.items);

  it('TC-88-13 BL-178 a term without accents finds the name with accents, in any case', async () => {
    await customer('Nguyễn Văn A');
    await customer('Nguyễn Thị B');
    await customer('Nguyen Quốc Mixed'); // a name typed without accents is found by the accented term
    for (const term of ['nguyen', 'NGUYEN', 'Nguyen', 'nguyễn', 'NGUYỄN', 'nguyên', 'ngũyen']) {
      const result = await found(term);
      expect({ term, result: result.filter(n => /^Nguy/.test(n)).sort() }).toEqual({
        term,
        result: ['Nguyen Quốc Mixed', 'Nguyễn Thị B', 'Nguyễn Văn A'],
      });
    }
    expect(await found('nguyen van')).toEqual(['Nguyễn Văn A']);
    expect(await found('VAN A')).toEqual(['Nguyễn Văn A']);
    expect(await found('văn a')).toEqual(['Nguyễn Văn A']);
    expect(await found('quoc mixed')).toEqual(['Nguyen Quốc Mixed']);
  });

  it('TC-88-14 BL-178 đ/Đ, ư/Ư and ơ/Ơ fold the same way whatever the case of name or term', async () => {
    await customer('Đức Anh Qwx');
    await customer('đức anh rty');
    await customer('Ưng Ơn Uvw');
    await customer('ưng ơn xyz');
    expect((await found('duc anh')).sort()).toEqual(['Đức Anh Qwx', 'đức anh rty']);
    for (const term of ['đức anh', 'ĐỨC ANH', 'Đức Anh', 'DUC ANH', 'đuc anh', 'Duc Anh'])
      expect({ term, result: (await found(term)).sort() }).toEqual({
        term,
        result: ['Đức Anh Qwx', 'đức anh rty'],
      });
    expect(await found('đức anh qwx')).toEqual(['Đức Anh Qwx']);
    for (const term of ['ưng ơn', 'ƯNG ƠN', 'Ưng Ơn', 'ung on', 'UNG ON', 'ưng on', 'ung ơn'])
      expect({ term, result: (await found(term)).sort() }).toEqual({
        term,
        result: ['Ưng Ơn Uvw', 'ưng ơn xyz'],
      });
    expect(await found('ƯNG ƠN UVW')).toEqual(['Ưng Ơn Uvw']);
    expect(await found('ung on xyz')).toEqual(['ưng ơn xyz']);
  });

  it('TC-88-15 BL-178 a name stored in decomposed form (NFD) is found like the composed one', async () => {
    const decomposed = 'Nguyễn Thị Nfd'.normalize('NFD');
    expect(decomposed).not.toBe('Nguyễn Thị Nfd');
    await customer(decomposed);
    expect((await found('nguyen thi nfd')).map(n => n.normalize('NFC'))).toEqual([
      'Nguyễn Thị Nfd',
    ]);
    expect((await found('nguyễn thị nfd')).map(n => n.normalize('NFC'))).toEqual([
      'Nguyễn Thị Nfd',
    ]);
  });

  it('TC-88-16 BL-178 % _ and \\ stay literal after folding, and nothing folds into a wildcard', async () => {
    await customer('Giảm 99% Phí');
    await customer('Giảm 99 Phí');
    await customer('Lê_Hân');
    await customer('Lê Hân');
    expect(await found('giam 99%')).toEqual(['Giảm 99% Phí']);
    expect(await found('GIẢM 99%')).toEqual(['Giảm 99% Phí']);
    expect(await found('le_han')).toEqual(['Lê_Hân']);
    expect(await found('le han')).toEqual(['Lê Hân']);
    expect(await found('Phi%')).toEqual([]);
    // unaccent turns the full-width ％ (U+FF05) and ＿ (U+FF3F) into % and _. The escaping runs after
    // the folding, so even these are text and not wildcards.
    const folded = (await q("SELECT public.f_unaccent('％＿﹪') AS v"))[0].v;
    expect(folded).toBe('%_%');
    expect(await found('99％')).toEqual(['Giảm 99% Phí']);
    expect(await found('le＿han')).toEqual(['Lê_Hân']);
    expect(await found('Phi＿')).toEqual([]);
    expect(await found('＿')).toEqual(expect.arrayContaining(['Lê_Hân']));
    expect((await found('＿')).every(n => n.includes('_'))).toBe(true);
    // A backslash typed by the operator is text, with or without accents around it.
    expect(await found('\\Ngang')).toEqual(['Đường\\Ngang']);
    expect(await found('duong\\ngang')).toEqual(['Đường\\Ngang']);
  });

  it('TC-88-17 BL-178 the term is a bound parameter: SQL in it is searched for, never run', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM customers'))[0].n;
    for (const term of [
      "' OR '1'='1",
      "x%' OR full_name LIKE '%",
      "'; DROP TABLE customers; --",
      "') OR 1=1 --",
    ]) {
      expect({ term, result: await found(term) }).toEqual({ term, result: [] });
      const { sql, parameters } = buildSearchSql(parseSearchQuery({ q: term }));
      expect(sql).not.toContain(term.trim());
      expect(sql).toMatch(/\$1/);
      expect(parameters).toHaveLength(1);
    }
    expect((await q('SELECT count(*)::int AS n FROM customers'))[0].n).toBe(before);
  });

  it('TC-88-18 BL-178 dbs_api, the role the API runs as, runs the search and may call unaccent', async () => {
    await customer('Trịnh Công Dbsapi');
    const { sql, parameters } = buildSearchSql(parseSearchQuery({ q: 'trinh cong dbsapi' }));
    const rows = await api.query<Item[]>(sql, parameters);
    expect(rows.map(r => r.ownerName)).toEqual(['Trịnh Công Dbsapi']);
    const [grants] = (await q(
      `SELECT has_function_privilege('dbs_api','public.f_unaccent(text)','EXECUTE') AS wrapper,
              has_function_privilege('dbs_api','public.unaccent(regdictionary,text)','EXECUTE') AS plain,
              has_function_privilege('dbs_worker','public.f_unaccent(text)','EXECUTE') AS worker`,
    )) as { wrapper: boolean; plain: boolean; worker: boolean }[];
    expect(grants).toEqual({ wrapper: true, plain: true, worker: true });
    // The role can use the search; it cannot create or drop the extension.
    await expect(api.query('DROP EXTENSION unaccent CASCADE')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('TC-88-19 BL-178 f_unaccent is IMMUTABLE, STRICT and fixes its dictionary, so an expression index can use it later', async () => {
    const [fn] = (await q(
      `SELECT p.provolatile, p.proisstrict, p.proparallel, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p WHERE p.oid = 'public.f_unaccent(text)'::regprocedure`,
    )) as { provolatile: string; proisstrict: boolean; proparallel: string; def: string }[];
    expect(fn).toMatchObject({ provolatile: 'i', proisstrict: true, proparallel: 's' });
    expect(fn.def).toContain("public.unaccent('public.unaccent'::regdictionary");
    expect((await q('SELECT public.f_unaccent(NULL::text) AS v'))[0].v).toBeNull();
    expect((await q("SELECT 1 FROM pg_extension WHERE extname='unaccent'")).length).toBe(1);
  });

  it('TC-88-20 BL-178 lower(f_unaccent(x)) of every Vietnamese letter is plain ASCII, whatever the locale of the database', async () => {
    const letters =
      'AĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY' +
      'ÁÀẢÃẠẮẰẲẴẶẤẦẨẪẬÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ';
    const all = letters + letters.toLowerCase();
    const expected = all.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
    const folded = async (runner: { query: (sql: string, args: unknown[]) => Promise<unknown> }) =>
      (
        (await runner.query('SELECT lower(public.f_unaccent($1)) AS v', [all])) as { v: string }[]
      )[0].v;
    expect(await folded(db.runner)).toBe(expected);
    expect(expected).toMatch(/^[\x20-\x7e]+$/);

    // The same on a database whose locale is C: there lower() does not fold Ư/ư or Ơ/ơ (which is
    // what made ILIKE depend on the server), but after unaccent nothing is left to fold.
    const name = `dbs_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await q(
      `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    const url = new URL(db.url);
    url.pathname = `/${name}`;
    let cDb: DataSource | undefined;
    try {
      await migrate(url.toString());
      cDb = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
      const [{ ctype }] = await cDb.query<{ ctype: string }[]>(
        'SELECT datctype AS ctype FROM pg_database WHERE datname = current_database()',
      );
      expect(ctype).toBe('C');
      const [plain] = await cDb.query<{ ilike_u: boolean; lower_o: boolean }[]>(
        `SELECT 'Ư' ILIKE 'ư' AS ilike_u, lower('Ơ') = 'ơ' AS lower_o`,
      );
      expect(plain).toEqual({ ilike_u: false, lower_o: false });
      expect(await folded(cDb)).toBe(expected);
      const [{ hit }] = await cDb.query<{ hit: boolean }[]>(
        `SELECT lower(public.f_unaccent('NGUYỄN ƯƠ')) LIKE lower(public.f_unaccent('%nguyễn ưƠ%')) AS hit`,
      );
      expect(hit).toBe(true);
    } finally {
      await cDb?.destroy();
      await q(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });

  it('TC-88-21 BL-178 down() removes the wrapper and the extension, up() brings them back', async () => {
    const migration = new EnableUnaccentSearch1795000008000();
    const present = async () =>
      (
        (await q(
          `SELECT (SELECT count(*) FROM pg_extension WHERE extname='unaccent')::int AS ext,
                  (SELECT count(*) FROM pg_proc WHERE proname='f_unaccent')::int AS fn`,
        )) as { ext: number; fn: number }[]
      )[0];
    expect(await present()).toEqual({ ext: 1, fn: 1 });
    await migration.down(db.runner);
    try {
      expect(await present()).toEqual({ ext: 0, fn: 0 });
    } finally {
      await migration.up(db.runner);
    }
    expect(await present()).toEqual({ ext: 1, fn: 1 });
    expect(await found('nguyen van')).toEqual(['Nguyễn Văn A']);
    // Running up() twice is harmless: the extension is IF NOT EXISTS, the wrapper OR REPLACE.
    await migration.up(db.runner);
    expect(await present()).toEqual({ ext: 1, fn: 1 });
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
