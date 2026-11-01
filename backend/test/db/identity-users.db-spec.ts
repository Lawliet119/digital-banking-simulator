import {
  createIdentityUsersFixture,
  waitForLockWaiters,
  type IdentityUsersFixture,
} from '../support/identity-users-probe';

const CALLERS = 20;

/** Subs shaped like Cognito's: a UUID, one per scenario so tests never see each other's rows. */
const sub = (n: number): string => `5b0d7c1e-3f4a-4c8e-9d2b-${String(n).padStart(12, '0')}`;

describe('DBS-52 users provisioning on PostgreSQL', () => {
  let fixture: IdentityUsersFixture;

  beforeAll(async () => {
    fixture = await createIdentityUsersFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  /** CALLERS services, each with its own cache and its own connection, all asking for one sub. */
  async function raceServices(subject: string) {
    const services = await Promise.all(Array.from({ length: CALLERS }, () => fixture.newService()));
    return services.map(({ service }) => service.resolveUserId(subject));
  }

  it('TC-52-13 20 callers with separate caches wait on a COMMIT: one row, one id, no unique error', async () => {
    const subject = sub(13);
    const holder = await fixture.openHolder(subject);

    const calls = await raceServices(subject);
    const settled = Promise.allSettled(calls);
    await waitForLockWaiters(fixture.admin, holder.pid, CALLERS);
    await holder.commit();

    const results = await settled;
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    expect(results.map(r => (r as PromiseFulfilledResult<string>).value)).toEqual(
      Array(CALLERS).fill(holder.id),
    );
    expect(await fixture.countUsers([subject])).toBe(1);
  });

  it('TC-52-14 20 callers wait on a ROLLBACK: exactly one inserts, the others read its row', async () => {
    const subject = sub(14);
    const holder = await fixture.openHolder(subject);

    const calls = await raceServices(subject);
    const settled = Promise.allSettled(calls);
    await waitForLockWaiters(fixture.admin, holder.pid, CALLERS);
    await holder.rollback();

    const results = await settled;
    expect(results.filter(r => r.status === 'rejected')).toEqual([]);
    const ids = results.map(r => (r as PromiseFulfilledResult<string>).value);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(holder.id); // the rolled-back row never existed
    expect(await fixture.countUsers([subject])).toBe(1);
  });

  it('TC-52-14b 20 parallel calls through ONE service share a single flight (not a proof of ON CONFLICT)', async () => {
    const subject = sub(15);
    const { service } = await fixture.newService();

    const ids = await Promise.all(
      Array.from({ length: CALLERS }, () => service.resolveUserId(subject)),
    );

    expect(new Set(ids).size).toBe(1);
    expect(await fixture.countUsers([subject])).toBe(1);
  });

  it('TC-52-15 gives each distinct sub its own row, whatever role it will carry', async () => {
    const subjects = ['customer', 'operator', 'auditor', 'admin', 'no-group'].map((_, i) =>
      sub(100 + i),
    );
    const { service } = await fixture.newService();

    const ids = await Promise.all(subjects.map(s => service.resolveUserId(s)));

    expect(new Set(ids).size).toBe(subjects.length);
    expect(await fixture.countUsers(subjects)).toBe(subjects.length);
  });

  it('TC-52-16 leaves an existing row untouched (created_at, sessions_revoked_at, row count)', async () => {
    const subject = sub(16);
    const [seeded] = await fixture.admin.query<{ id: string }[]>(
      `INSERT INTO users (cognito_sub, sessions_revoked_at, created_at)
       VALUES ($1, '2026-10-30T08:00:00Z', '2026-10-01T00:00:00Z') RETURNING id`,
      [subject],
    );
    const before = await fixture.admin.query('SELECT * FROM users WHERE cognito_sub = $1', [
      subject,
    ]);
    const { service } = await fixture.newService();

    await expect(service.resolveUserId(subject)).resolves.toBe(seeded.id);

    const after = await fixture.admin.query('SELECT * FROM users WHERE cognito_sub = $1', [
      subject,
    ]);
    expect(after).toEqual(before);
    expect(await fixture.countUsers([subject])).toBe(1);
  });

  it('TC-52-17 stores a hostile sub verbatim and leaves the table alone', async () => {
    const hostile = "x'; DROP TABLE users;--";
    const { service } = await fixture.newService();

    const id = await service.resolveUserId(hostile);

    const rows = await fixture.admin.query<{ cognito_sub: string }[]>(
      'SELECT cognito_sub FROM users WHERE id = $1',
      [id],
    );
    expect(rows).toEqual([{ cognito_sub: hostile }]);
    const [{ present }] = await fixture.admin.query<{ present: boolean }[]>(
      "SELECT to_regclass('public.users') IS NOT NULL AS present",
    );
    expect(present).toBe(true);
  });
});
