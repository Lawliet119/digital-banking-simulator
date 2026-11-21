import {
  createRolePermissionsFixture,
  expectAclDenied,
  rollbackProbe,
  type RolePermissionsFixture,
} from '../support/db-role-permissions';
import { counterOf, ledgerTruth } from '../support/daily-debit-counter';

/**
 * BL-418, TC-418-11. The counter is written by a SECURITY DEFINER trigger, so the application role
 * needs no grant on the new columns and cannot move them: its UPDATE on accounts is column-level
 * (balance, status, updated_at). Run as the real `dbs_api` and `dbs_worker` logins of DBS-122.
 */
describe('BL-418 the day counter under the real dbs_api role', () => {
  let fixture: RolePermissionsFixture;
  beforeAll(async () => {
    fixture = await createRolePermissionsFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it('TC-418-11 counts the transfers the API wrote as dbs_api, and only the sender', async () => {
    const [sender, receiver] = fixture.accounts;
    // 1,000 + 2,000 + 3,000 sent over HTTP by the fixture, through the unprivileged runtime role
    const truth = await ledgerTruth(fixture.owner as never, sender);
    expect(truth.sentToday).toBe('6000');
    expect(await counterOf(fixture.owner as never, sender)).toEqual(truth);
    expect(await counterOf(fixture.owner as never, receiver)).toEqual({
      sentToday: '0',
      sentDay: null,
    });
  });

  it.each(['sent_today = 0', 'sent_day = NULL', 'sent_today = 1, sent_day = current_date'])(
    'TC-418-11 dbs_api cannot UPDATE the counter (%s): ACL denial, not a constraint',
    async assignment => {
      const [sender] = fixture.accounts;
      expect(
        await expectAclDenied(fixture.api, `UPDATE accounts SET ${assignment} WHERE id = $1`, [
          sender,
        ]),
      ).toBe('42501');
      expect(await expectAclDenied(fixture.worker, `UPDATE accounts SET ${assignment}`, [])).toBe(
        '42501',
      );
    },
  );

  it('TC-418-11 dbs_api keeps its column-level UPDATE of the balance', async () => {
    const [sender] = fixture.accounts;
    await expect(
      rollbackProbe(fixture.api, 'UPDATE accounts SET balance = balance WHERE id = $1', [sender]),
    ).resolves.toBeUndefined();
  });

  it('TC-418-11 records the accepted gap: dbs_api can INSERT an account with a counter of its choosing (BL-422)', async () => {
    const [sender] = fixture.accounts;
    // The table-level INSERT grant covers the new columns. The invariant check daily_debit_totals
    // reports such a row (TC-418-10); narrowing the grant is BL-422, work for the roles owner.
    await expect(
      rollbackProbe(
        fixture.api,
        `INSERT INTO accounts(customer_id, type, status, sent_today, sent_day)
         SELECT customer_id, 'SAVINGS', 'ACTIVE', 7, DATE '2030-01-01' FROM accounts WHERE id = $1`,
        [sender],
      ),
    ).resolves.toBeUndefined();
  });
});
