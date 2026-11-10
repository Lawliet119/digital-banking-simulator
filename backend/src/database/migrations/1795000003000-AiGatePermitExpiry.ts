import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A permit whose release was lost (worker killed, release failed or timed out) used to count as
 * active for ever. Permits older than the policy's TTL no longer count toward `concurrent_limit`;
 * the daily request count is unchanged, so an expired permit never refunds budget.
 *
 * The TTL must exceed the longest legitimate call (`requestTimeoutMs + maxAdmissionDelayMs`).
 */
export class AiGatePermitExpiry1795000003000 implements MigrationInterface {
  name = 'AiGatePermitExpiry1795000003000';

  private acquireFunction(activeFilter: string): string {
    return `CREATE OR REPLACE FUNCTION public.ai_gate_acquire(p_token uuid, p_revision text, p_daily integer, p_concurrent integer)
    RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    DECLARE policy public.ai_gate_policy%ROWTYPE; today date; used bigint;
    BEGIN
      SELECT * INTO policy FROM public.ai_gate_policy WHERE singleton FOR UPDATE;
      IF NOT FOUND OR p_revision IS DISTINCT FROM policy.revision
        OR p_daily IS DISTINCT FROM policy.daily_limit
        OR p_concurrent IS DISTINCT FROM policy.concurrent_limit THEN RETURN 'unavailable'; END IF;
      IF EXISTS (SELECT 1 FROM public.ai_gate_permits WHERE token = p_token) THEN
        RETURN 'unavailable';
      END IF;
      today := (clock_timestamp() AT TIME ZONE 'UTC')::date;
      INSERT INTO public.ai_gate_days(day, requests) VALUES(today, 0) ON CONFLICT DO NOTHING;
      SELECT requests INTO used FROM public.ai_gate_days WHERE day = today;
      IF used >= policy.daily_limit THEN RETURN 'budget_exhausted'; END IF;
      IF (SELECT count(*) FROM public.ai_gate_permits WHERE released_at IS NULL${activeFilter}) >= policy.concurrent_limit
        THEN RETURN 'unavailable'; END IF;
      UPDATE public.ai_gate_days SET requests = requests + 1 WHERE day = today;
      INSERT INTO public.ai_gate_permits(token) VALUES(p_token);
      RETURN 'granted';
    END $$`;
  }

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE public.ai_gate_policy
      ADD COLUMN permit_ttl_seconds integer NOT NULL DEFAULT 900 CHECK (permit_ttl_seconds > 0)`);
    await q.query(
      `CREATE INDEX ai_gate_active_permits_reserved ON public.ai_gate_permits(reserved_at) WHERE released_at IS NULL`,
    );
    // CREATE OR REPLACE keeps the owner and the EXECUTE grants of the original function.
    await q.query(
      this.acquireFunction(
        ` AND reserved_at > clock_timestamp() - make_interval(secs => policy.permit_ttl_seconds)`,
      ),
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(this.acquireFunction(''));
    await q.query('DROP INDEX public.ai_gate_active_permits_reserved');
    await q.query('ALTER TABLE public.ai_gate_policy DROP COLUMN permit_ttl_seconds');
  }
}
