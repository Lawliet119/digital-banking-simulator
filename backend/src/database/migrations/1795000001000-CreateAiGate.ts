import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiGate1795000001000 implements MigrationInterface {
  name = 'CreateAiGate1795000001000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE public.ai_gate_policy (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 128),
      daily_limit integer NOT NULL CHECK (daily_limit > 0),
      concurrent_limit integer NOT NULL CHECK (concurrent_limit > 0)
    );
    CREATE TABLE public.ai_gate_days (
      day date PRIMARY KEY,
      requests bigint NOT NULL CHECK (requests >= 0)
    );
    CREATE TABLE public.ai_gate_permits (
      token uuid PRIMARY KEY,
      reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      released_at timestamptz
    );
    CREATE INDEX ai_gate_active_permits ON public.ai_gate_permits(token) WHERE released_at IS NULL;
    REVOKE ALL ON public.ai_gate_policy, public.ai_gate_days, public.ai_gate_permits FROM PUBLIC;
    CREATE FUNCTION public.ai_gate_acquire(p_token uuid, p_revision text, p_daily integer, p_concurrent integer)
    RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
      IF (SELECT count(*) FROM public.ai_gate_permits WHERE released_at IS NULL) >= policy.concurrent_limit
        THEN RETURN 'unavailable'; END IF;
      UPDATE public.ai_gate_days SET requests = requests + 1 WHERE day = today;
      INSERT INTO public.ai_gate_permits(token) VALUES(p_token);
      RETURN 'granted';
    END $$;
    CREATE FUNCTION public.ai_gate_release(p_token uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
      UPDATE public.ai_gate_permits SET released_at = clock_timestamp()
      WHERE token = p_token AND released_at IS NULL;
    $$;
    REVOKE ALL ON FUNCTION public.ai_gate_acquire(uuid,text,integer,integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.ai_gate_release(uuid) FROM PUBLIC;`);
  }

  async down(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive) throw new Error('AI gate rollback requires a transaction');
    // The lock closes the race between checking for reservations and dropping the gate.
    await q.query(
      'LOCK TABLE public.ai_gate_policy, public.ai_gate_days, public.ai_gate_permits IN ACCESS EXCLUSIVE MODE',
    );
    const [{ populated }] = (await q.query(`SELECT
      EXISTS(SELECT FROM public.ai_gate_days) OR EXISTS(SELECT FROM public.ai_gate_permits) AS populated`)) as {
      populated: boolean;
    }[];
    if (populated) throw new Error('Refusing to revert populated AI gate; preserve budget history');
    await q.query(`DROP FUNCTION public.ai_gate_acquire(uuid,text,integer,integer);
      DROP FUNCTION public.ai_gate_release(uuid);
      DROP TABLE public.ai_gate_permits, public.ai_gate_days, public.ai_gate_policy;`);
  }
}
