import { randomUUID } from 'node:crypto';
import { exportSPKI, importJWK, SignJWT } from 'jose';
import request from 'supertest';
import { ErrorCode } from '../../src/common/errors/error-code.enum';
import { checkLedgerInvariants } from '../support/invariants';
import { startDepositApp } from '../support/deposit-app';
import { createDevTokenIssuer } from '../support/dev-tokens';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * DBS-159: the obvious attacks on identity, run against the real money endpoints, real JWT checks
 * and real PostgreSQL. Every refused attempt is followed by a look at the tables that hold money and
 * retry keys: a refusal that still wrote a row would be worse than no refusal. Threat model T1, T2,
 * T13, T21; design in docs/features/DBS-159-auth-attack-tests.md.
 */
describe('DBS-159 attacks on identity, keys and roles (security, real PostgreSQL)', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) =>
    db.runner.query(sql, args) as Promise<T[]>;

  interface Customer {
    sub: string;
    userId: string;
    token: string;
    accounts: string[];
  }
  let an: Customer, binh: Customer;
  let chi: string, dung: string;
  /** An's own transfer A1 → A2 with key K: Bình is neither its sender nor its recipient. */
  let K: string, T: string;
  const anBody = () => ({
    fromAccountId: an.accounts[0],
    toAccountId: an.accounts[1],
    amount: '200000',
  });

  async function customer(fullName: string, types: string[]): Promise<Customer> {
    const sub = randomUUID();
    const token = await app.issuer.token('customer', { sub });
    await request(app.url)
      .post('/v1/customers/me')
      .auth(token, { type: 'bearer' })
      .send({ fullName })
      .expect(200);
    const accounts: string[] = [];
    for (const type of types) {
      const res = await request(app.url)
        .post('/v1/accounts')
        .auth(token, { type: 'bearer' })
        .send({ type })
        .expect(201);
      accounts.push(res.body.id as string);
    }
    const [{ id }] = await q<{ id: string }>('SELECT id FROM users WHERE cognito_sub=$1', [sub]);
    return { sub, userId: id, token, accounts };
  }

  const transfer = (token: string | undefined, key: string, body: object) => {
    const req = request(app.url).post('/v1/transfers').set('Idempotency-Key', key);
    if (token !== undefined) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };
  const deposit = (token: string | undefined, key: string, toAccountId: string, amount: string) => {
    const req = request(app.url).post('/v1/operator/deposits').set('Idempotency-Key', key);
    if (token !== undefined) req.set('Authorization', `Bearer ${token}`);
    return req.send({ toAccountId, amount });
  };

  /** Everything a refused request must leave untouched. `users` is left out on purpose (§2). */
  async function snapshot() {
    const [counts] = await q<{
      transfers: number;
      keys: number;
      ledger: number;
      outbox: number;
      audit: number;
    }>(
      `SELECT (SELECT count(*) FROM transfers)::int AS transfers,
              (SELECT count(*) FROM idempotency_keys)::int AS keys,
              (SELECT count(*) FROM ledger_entries)::int AS ledger,
              (SELECT count(*) FROM outbox_events)::int AS outbox,
              (SELECT count(*) FROM audit_log)::int AS audit`,
    );
    const balances = await q(
      `SELECT id, balance::text, status FROM accounts WHERE type <> 'SYSTEM' ORDER BY id`,
    );
    return { ...counts, balances };
  }

  /**
   * A 403 of RolesGuard writes no business row, but exactly one audit_log DENIED row per refusal
   * (BL-132, FR-AUD-02): the snapshot is unchanged except for `audit`, which grew by `denials`.
   */
  async function expectOnlyDenialRows(
    before: Awaited<ReturnType<typeof snapshot>>,
    denials: number,
  ) {
    const after = await snapshot();
    expect({ ...after, audit: after.audit - denials }).toEqual(before);
  }

  /** The `access.denied` rows of one request, found by the correlationId the response carried. */
  async function denialRows(correlationId: unknown) {
    return q<{
      actor_user_id: string;
      actor_role: string;
      action: string;
      outcome: string;
      target_type: string;
      target_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, actor_role, action, outcome, target_type, target_id, metadata
         FROM audit_log WHERE correlation_id=$1`,
      [correlationId],
    );
  }

  const withoutCorrelation = (body: Record<string, unknown>) => {
    const { correlationId: _ignored, ...rest } = body;
    return rest;
  };

  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
    chi = await app.issuer.token('operator', { sub: `operator-chi-${randomUUID()}` });
    dung = await app.issuer.token('operator', { sub: `operator-dung-${randomUUID()}` });
    an = await customer('Trần Văn An', ['CHECKING', 'SAVINGS']);
    binh = await customer('Nguyễn Thị Bình', ['CHECKING']);
    await deposit(chi, randomUUID(), an.accounts[0], '5000000').expect(201);
    await deposit(chi, randomUUID(), binh.accounts[0], '1000000').expect(201);
    K = randomUUID();
    const first = await transfer(an.token, K, anBody()).expect(201);
    expect(first.body).toEqual({ transferId: expect.any(String), status: 'COMPLETED' });
    T = first.body.transferId as string;
  });

  afterEach(async () => {
    const report = await checkLedgerInvariants(db.runner);
    expect(report.violations).toEqual([]);
    expect(report.status).toBe('PASS');
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  describe('DoD #1 Idempotency-Key of another user (T13)', () => {
    it("TC-159-01 Bình replaying An's key with An's exact body gets the plain 404 of a foreign source, never An's result", async () => {
      const before = await snapshot();
      const res = await transfer(binh.token, K, anBody()).expect(404);
      expect(JSON.stringify(res.body)).not.toContain(T);
      expect(JSON.stringify(res.body)).not.toContain('200000');
      expect(res.body).not.toHaveProperty('errorCode');
      expect(res.body).not.toHaveProperty('transferId');

      // Same answer as for an account that does not exist at all: the key reveals nothing.
      const missing = await transfer(binh.token, randomUUID(), {
        ...anBody(),
        fromAccountId: randomUUID(),
      }).expect(404);
      expect(withoutCorrelation(res.body)).toEqual(withoutCorrelation(missing.body));

      const after = await snapshot();
      expect(after.transfers).toBe(before.transfers);
      expect(after.keys).toBe(before.keys);
      expect(after.ledger).toBe(before.ledger);
      expect(after.outbox).toBe(before.outbox);
      expect(after.balances).toEqual(before.balances);
      expect(
        await q('SELECT 1 FROM idempotency_keys WHERE user_id=$1 AND idem_key=$2', [
          binh.userId,
          K,
        ]),
      ).toHaveLength(0);
      const denied = await q<{ action: string; actor_role: string; outcome: string }>(
        'SELECT action, actor_role, outcome FROM audit_log WHERE actor_user_id=$1 AND correlation_id=$2',
        [binh.userId, res.body.correlationId],
      );
      expect(denied).toEqual([
        { action: 'ledger.transfer', actor_role: 'customer', outcome: 'DENIED' },
      ]);
    });

    it('TC-159-02 Bình using the same key for his own transfer gets a new transfer; An still replays T', async () => {
      const mine = await transfer(binh.token, K, {
        fromAccountId: binh.accounts[0],
        toAccountId: an.accounts[0],
        amount: '100000',
      }).expect(201);
      expect(mine.body.status).toBe('COMPLETED');
      expect(mine.body.transferId).not.toBe(T);
      const owners = await q<{ user_id: string }>(
        'SELECT user_id FROM idempotency_keys WHERE idem_key=$1 ORDER BY user_id',
        [K],
      );
      expect(owners.map(r => r.user_id).sort()).toEqual([an.userId, binh.userId].sort());

      const before = await snapshot();
      const replay = await transfer(an.token, K, anBody()).expect(201);
      expect(replay.body).toEqual({ transferId: T, status: 'COMPLETED' });
      const after = await snapshot();
      expect(after.transfers).toBe(before.transfers);
      expect(after.balances).toEqual(before.balances);
    });

    it("TC-159-03 Bình cannot read An's transfer by id: 404 with no amount or account, audited DENIED", async () => {
      const res = await request(app.url)
        .get(`/v1/transfers/${T}`)
        .auth(binh.token, { type: 'bearer' })
        .expect(404);
      const text = JSON.stringify(res.body);
      for (const secret of [T, '200000', an.accounts[0], an.accounts[1]]) {
        expect(text).not.toContain(secret);
      }
      const denied = await q<{ action: string; outcome: string }>(
        'SELECT action, outcome FROM audit_log WHERE actor_user_id=$1 AND correlation_id=$2',
        [binh.userId, res.body.correlationId],
      );
      expect(denied).toEqual([{ action: 'transfer.read', outcome: 'DENIED' }]);

      const own = await request(app.url)
        .get(`/v1/transfers/${T}`)
        .auth(an.token, { type: 'bearer' })
        .expect(200);
      expect(own.body).toMatchObject({ transferId: T, amount: '200000', status: 'COMPLETED' });
    });

    it("TC-159-04 a deposit key is per operator: Dũng reusing Chi's key makes his own deposit, Chi still replays hers", async () => {
      const K2 = randomUUID();
      const first = await deposit(chi, K2, binh.accounts[0], '300000').expect(201);
      const other = await deposit(dung, K2, binh.accounts[0], '300000').expect(201);
      expect(other.body.transferId).not.toBe(first.body.transferId);
      const replay = await deposit(chi, K2, binh.accounts[0], '300000').expect(201);
      expect(replay.body).toEqual(first.body);
      const rows = await q('SELECT 1 FROM transfers WHERE id = ANY($1::uuid[])', [
        [first.body.transferId, other.body.transferId],
      ]);
      expect(rows).toHaveLength(2); // ADR-05: two operators, two commands; documented consequence
    });
  });

  describe('DoD #2 tokens that are missing, forged or expired (T1)', () => {
    const body = () => ({
      fromAccountId: an.accounts[0],
      toAccountId: binh.accounts[0],
      amount: '50000',
    });

    async function forgedTokens() {
      const now = Math.floor(Date.now() / 1000);
      const genuine = await app.issuer.token('customer', { sub: an.sub });
      const [header, payload, signature] = genuine.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const sameKid = await createDevTokenIssuer({ kid: app.issuer.kid });
      const publicPem = await exportSPKI(
        (await importJWK(app.issuer.jwks.keys[0], 'RS256')) as Parameters<typeof exportSPKI>[0],
      );
      return {
        garbage: 'not-a-jwt',
        otherKeySameKid: await sameKid.token('customer', { sub: an.sub }),
        editedPayload: `${header}.${b64({ ...claims, 'cognito:groups': ['operator'] })}.${signature}`,
        algNone: `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`,
        hs256WithPublicKey: await new SignJWT(claims)
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: app.issuer.kid })
          .sign(new TextEncoder().encode(publicPem)),
        idToken: await app.issuer.signClaims('customer', { token_use: 'id' }, { sub: an.sub }),
        expired: await app.issuer.token('customer', {
          sub: an.sub,
          iat: now - 1000,
          exp: now - 100,
        }),
        expiredOperator: await app.issuer.token('operator', {
          sub: `operator-chi-old-${randomUUID()}`,
          iat: now - 1000,
          exp: now - 100,
        }),
      };
    }

    it('TC-159-05 no token, garbage, another key with the same kid, edited payload, alg none, HS256 with the public key and an ID token are all 401 UNAUTHENTICATED, with nothing written', async () => {
      const t = await forgedTokens();
      const before = await snapshot();
      const attempts: [string, string | undefined][] = [
        ['no token', undefined],
        ['garbage', t.garbage],
        ['another key, same kid', t.otherKeySameKid],
        ['edited payload', t.editedPayload],
        ['alg none', t.algNone],
        ['HS256 with the public key', t.hs256WithPublicKey],
        ['ID token', t.idToken],
      ];
      for (const [name, token] of attempts) {
        const res = await transfer(token, randomUUID(), body());
        expect({ name, status: res.status, errorCode: res.body.errorCode }).toEqual({
          name,
          status: 401,
          errorCode: ErrorCode.UNAUTHENTICATED,
        });
      }
      // JwtAuthGuard runs before RolesGuard: a forged "operator" is 401, never 403 or 201.
      for (const [name, token] of [
        ['no token', undefined],
        ['edited payload', t.editedPayload],
      ] as const) {
        const res = await deposit(token, randomUUID(), binh.accounts[0], '1000000');
        expect({ name, status: res.status, errorCode: res.body.errorCode }).toEqual({
          name,
          status: 401,
          errorCode: ErrorCode.UNAUTHENTICATED,
        });
      }
      expect(await snapshot()).toEqual(before);
    });

    it('TC-159-06 an expired customer token on a transfer and an expired operator token on a deposit are 401 TOKEN_EXPIRED', async () => {
      const t = await forgedTokens();
      const before = await snapshot();
      const onTransfer = await transfer(t.expired, randomUUID(), body()).expect(401);
      expect(onTransfer.body.errorCode).toBe(ErrorCode.TOKEN_EXPIRED);
      const onDeposit = await deposit(
        t.expiredOperator,
        randomUUID(),
        binh.accounts[0],
        '1000000',
      ).expect(401);
      expect(onDeposit.body.errorCode).toBe(ErrorCode.TOKEN_EXPIRED);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('DoD #2 roles come only from cognito:groups (T21)', () => {
    const forgedHeaders = {
      'X-Role': 'operator',
      'X-Roles': 'operator',
      'X-User-Role': 'operator',
      'X-Cognito-Groups': 'operator',
      'X-Amzn-Oidc-Groups': 'operator',
      Cookie: 'role=operator; cognito:groups=operator',
    };
    const forgedBody = { role: 'operator', roles: ['operator'], 'cognito:groups': ['operator'] };

    it('TC-159-08 a customer token dressed up as operator by header, cookie, query and body is 403 on deposit and lock, writes no business row and leaves one DENIED audit row each (BL-132)', async () => {
      const before = await snapshot();
      const dep = await request(app.url)
        .post('/v1/operator/deposits?role=operator')
        .auth(binh.token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .set(forgedHeaders)
        .send({ toAccountId: binh.accounts[0], amount: '9000000', ...forgedBody })
        .expect(403);
      expect(dep.body.errorCode).toBe(ErrorCode.FORBIDDEN);
      const lock = await request(app.url)
        .post(`/v1/operator/accounts/${an.accounts[0]}/lock?role=operator`)
        .auth(binh.token, { type: 'bearer' })
        .set(forgedHeaders)
        .send({ reason: 'CONFIRMED_FRAUD', ...forgedBody })
        .expect(403);
      expect(lock.body.errorCode).toBe(ErrorCode.FORBIDDEN);
      // BL-132: each 403 is one DENIED row (the role the token really has, the route template, the
      // response's correlationId, no forged role anywhere); nothing else changed.
      await expectOnlyDenialRows(before, 2);
      expect(await denialRows(dep.headers['x-correlation-id'])).toEqual([
        {
          actor_user_id: binh.userId,
          actor_role: 'customer',
          action: 'access.denied',
          outcome: 'DENIED',
          target_type: 'route',
          target_id: 'POST /v1/operator/deposits',
          metadata: { reason: 'NO_PERMISSION' },
        },
      ]);
      expect(await denialRows(lock.headers['x-correlation-id'])).toEqual([
        {
          actor_user_id: binh.userId,
          actor_role: 'customer',
          action: 'access.denied',
          outcome: 'DENIED',
          target_type: 'route',
          target_id: 'POST /v1/operator/accounts/:id/lock',
          metadata: { reason: 'NO_PERMISSION' },
        },
      ]);
      const [anUser] = await q<{ sessions_revoked_at: Date | null }>(
        'SELECT sessions_revoked_at FROM users WHERE id=$1',
        [an.userId],
      );
      expect(anUser.sessions_revoked_at).toBeNull();
    });

    it('TC-159-09 a correctly signed customer token with role, custom:role and scope claims saying operator is still 403', async () => {
      const token = await app.issuer.signClaims(
        'customer',
        { role: 'operator', 'custom:role': 'operator', scope: 'operator admin' },
        { sub: binh.sub },
      );
      const before = await snapshot();
      const res = await deposit(token, randomUUID(), binh.accounts[0], '9000000').expect(403);
      expect(res.body.errorCode).toBe(ErrorCode.FORBIDDEN);
      await expectOnlyDenialRows(before, 1);
      // The extra claims do not change the recorded role: it is derived from cognito:groups only.
      const [row] = await denialRows(res.headers['x-correlation-id']);
      expect(row).toMatchObject({
        actor_role: 'customer',
        outcome: 'DENIED',
        actor_user_id: binh.userId,
      });
    });

    it('TC-159-10 no role hierarchy: auditor and admin are 403 on deposit and lock, operator is 403 on a customer transfer', async () => {
      const before = await snapshot();
      for (const role of ['auditor', 'admin'] as const) {
        const token = await app.issuer.token(role, { sub: `${role}-${randomUUID()}` });
        const dep = await deposit(token, randomUUID(), binh.accounts[0], '1000000');
        const lock = await request(app.url)
          .post(`/v1/operator/accounts/${an.accounts[0]}/lock`)
          .auth(token, { type: 'bearer' })
          .send({ reason: 'CONFIRMED_FRAUD' });
        for (const res of [dep, lock]) {
          expect({ role, status: res.status, errorCode: res.body.errorCode }).toEqual({
            role,
            status: 403,
            errorCode: ErrorCode.FORBIDDEN,
          });
          // BL-019 / AC-8.1: the auditor is read-only, and the refusal is itself evidence.
          const rows = await denialRows(res.headers['x-correlation-id']);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            actor_role: role,
            action: 'access.denied',
            outcome: 'DENIED',
          });
        }
      }
      const asOperator = await transfer(chi, randomUUID(), {
        fromAccountId: an.accounts[0],
        toAccountId: binh.accounts[0],
        amount: '50000',
      }).expect(403);
      expect(asOperator.body.errorCode).toBe(ErrorCode.FORBIDDEN);
      // 2 roles x (deposit + lock) + 1 operator transfer: one DENIED row per 403, no business row.
      await expectOnlyDenialRows(before, 5);
      const [operatorRow] = await denialRows(asOperator.headers['x-correlation-id']);
      expect(operatorRow).toMatchObject({
        actor_role: 'operator',
        target_id: 'POST /v1/transfers',
        outcome: 'DENIED',
      });
    });

    it('TC-159-11 role or user fields in a transfer body are refused (400); forged headers on a valid transfer change nothing about who acts', async () => {
      const before = await snapshot();
      const refused = await transfer(binh.token, randomUUID(), {
        fromAccountId: binh.accounts[0],
        toAccountId: an.accounts[0],
        amount: '10000',
        role: 'operator',
        userId: an.userId,
      }).expect(400);
      expect(refused.body).not.toHaveProperty('errorCode');
      expect(await snapshot()).toEqual(before);

      const done = await request(app.url)
        .post('/v1/transfers?role=operator')
        .auth(binh.token, { type: 'bearer' })
        .set('Idempotency-Key', randomUUID())
        .set(forgedHeaders)
        .send({ fromAccountId: binh.accounts[0], toAccountId: an.accounts[0], amount: '10000' })
        .expect(201);
      const [row] = await q<{ initiated_by: string }>(
        'SELECT initiated_by FROM transfers WHERE id=$1',
        [done.body.transferId],
      );
      expect(row.initiated_by).toBe(binh.userId);
      const audit = await q<{ actor_user_id: string; actor_role: string; outcome: string }>(
        `SELECT actor_user_id, actor_role, outcome FROM audit_log
          WHERE target_id=$1 AND action='transfer'`,
        [done.body.transferId],
      );
      expect(audit).toEqual([
        { actor_user_id: binh.userId, actor_role: 'customer', outcome: 'SUCCESS' },
      ]);
    });
  });

  describe('DoD #2 a revoked session (T2, AC-11.1), run last because it locks an account', () => {
    it('TC-159-07 after a lock, the old token is 401 SESSION_REVOKED on a transfer from the still ACTIVE account; a token issued the next second works', async () => {
      const oldToken = an.token;
      await request(app.url)
        .post(`/v1/operator/accounts/${an.accounts[1]}/lock`)
        .auth(chi, { type: 'bearer' })
        .send({ reason: 'CONFIRMED_FRAUD' })
        .expect(200);
      const [{ seconds }] = await q<{ seconds: string }>(
        'SELECT floor(extract(epoch FROM sessions_revoked_at))::bigint::text AS seconds FROM users WHERE id=$1',
        [an.userId],
      );
      const mark = Number(seconds);
      const move = {
        fromAccountId: an.accounts[0],
        toAccountId: binh.accounts[0],
        amount: '50000',
      };

      const before = await snapshot();
      const refused = await transfer(oldToken, randomUUID(), move).expect(401);
      expect(refused.body.errorCode).toBe(ErrorCode.SESSION_REVOKED);
      expect(await snapshot()).toEqual(before);

      const fresh = await app.issuer.token('customer', {
        sub: an.sub,
        iat: mark + 1,
        exp: mark + 900,
      });
      const ok = await transfer(fresh, randomUUID(), move).expect(201);
      expect(ok.body.status).toBe('COMPLETED');
    });
  });
});
