import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IdentityService } from '@modules/identity';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { seedDepositTarget, startDepositApp } from '../support/deposit-app';

/**
 * DBS-tech: a revoked session is refused on the very next request (BR-12, NFR-SEC-02), through the
 * real JWT guard, real HTTP and real PostgreSQL.
 */
describe('session revocation through JWT, HTTP and PostgreSQL', () => {
  let db: TempDatabase;
  let app: Awaited<ReturnType<typeof startDepositApp>>;
  const now = () => Math.floor(Date.now() / 1000);
  const me = (token: string) =>
    request(app.url).get('/v1/identity/me').auth(token, { type: 'bearer' });

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startDepositApp(db.url);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  it('TC-REV-01 a user that was never revoked is let in', async () => {
    const user = await seedDepositTarget(db.runner);
    const token = await app.issuer.token('customer', { sub: user.sub });
    await me(token).expect(200);
  });

  it('TC-REV-02 revoking in a transaction refuses the old token at once, a new one still works', async () => {
    const user = await seedDepositTarget(db.runner);
    const before = await app.issuer.token('customer', { sub: user.sub, iat: now() - 30 });
    await me(before).expect(200);

    const identity = app.app.get(IdentityService);
    const revokedAt = await app.source.transaction(manager =>
      identity.revokeSessions(manager, user.userId),
    );
    expect(Math.abs(revokedAt.getTime() - Date.now())).toBeLessThan(10_000);

    const refused = await me(before).expect(401);
    expect(refused.body.errorCode).toBe('SESSION_REVOKED');

    // The user signs in again a moment later: a token issued after the mark works.
    const after = await app.issuer.token('customer', { sub: user.sub, iat: now() + 2 });
    await me(after).expect(200);
  });

  it('TC-REV-03 a revocation rolled back with its transaction changes nothing', async () => {
    const user = await seedDepositTarget(db.runner);
    const token = await app.issuer.token('customer', { sub: user.sub, iat: now() - 30 });
    const identity = app.app.get(IdentityService);
    await expect(
      app.source.transaction(async manager => {
        await identity.revokeSessions(manager, user.userId);
        throw new Error('lock failed afterwards');
      }),
    ).rejects.toThrow('lock failed afterwards');
    await me(token).expect(200);
  });

  it('TC-REV-04 revoking one user does not touch another', async () => {
    const a = await seedDepositTarget(db.runner),
      b = await seedDepositTarget(db.runner);
    const tokenB = await app.issuer.token('customer', { sub: b.sub, iat: now() - 30 });
    const identity = app.app.get(IdentityService);
    await app.source.transaction(manager => identity.revokeSessions(manager, a.userId));
    await me(tokenB).expect(200);
  });

  it('TC-REV-05 revoking an unknown user is an error, not a silent no-op', async () => {
    const identity = app.app.get(IdentityService);
    await expect(
      app.source.transaction(manager => identity.revokeSessions(manager, randomUUID())),
    ).rejects.toThrow('unknown user');
  });
});
