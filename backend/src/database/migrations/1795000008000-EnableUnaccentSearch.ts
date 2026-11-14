import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BL-178: the operator's customer-name search (GET /v1/operator/accounts, DBS-88) must find
 * «Nguyễn» when the operator types «nguyen», and must not depend on how the PostgreSQL server
 * folds the case of accented letters (that depends on the locale of the server, which differs
 * between the Alpine/musl image and RDS/glibc). Both are solved by `unaccent`, applied before
 * `lower()`: the text is ASCII by the time the case is folded.
 *
 * Creates, in schema public:
 *   - the `unaccent` extension (contrib, shipped with PostgreSQL and supported by RDS). Vietnamese
 *     needs no extra rules: the default rules file maps đ/Đ to d/D and strips every tone mark and
 *     the horn/breve/circumflex of ư, ơ, ă, â, ê, ô;
 *   - `public.f_unaccent(text)`, an IMMUTABLE wrapper that fixes the dictionary
 *     (`public.unaccent`) and schema-qualifies the call. `unaccent(text)` itself is only STABLE
 *     (its dictionary is looked up through search_path), so it cannot be used in an index
 *     expression; the wrapper can, if the customer table ever grows enough to need a trigram
 *     index on `lower(f_unaccent(full_name))` (database-design §6.2: none today, ~50,000 rows).
 *
 * Grants: nothing to add. The function privilege of PostgreSQL goes to PUBLIC by default, and
 * neither the migrations nor infra/scripts/db-roles.sql revoke it from PUBLIC (they only revoke
 * from dbs_api/dbs_worker, which leaves the PUBLIC grant in place), so dbs_api can call both
 * functions. test/db/operator-account-search.db-spec.ts TC-88-18 proves it as the real role.
 *
 * Needs: CREATE on the database and on schema public. `unaccent` is a "trusted" extension (PG 13+),
 * so a non-superuser with CREATE on the database may create it; on RDS the master user (member of
 * rds_superuser) does. If the extension was already there (created by hand), `IF NOT EXISTS`
 * keeps it, and down() still drops it, because after this migration the search depends on it.
 */
export class EnableUnaccentSearch1795000008000 implements MigrationInterface {
  name = 'EnableUnaccentSearch1795000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public');
    await queryRunner.query(`CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
        SELECT public.unaccent('public.unaccent'::regdictionary, $1)
      $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No CASCADE: if an index or view was built on f_unaccent later, the revert must stop and say
    // so rather than drop it silently.
    await queryRunner.query('DROP FUNCTION public.f_unaccent(text)');
    await queryRunner.query('DROP EXTENSION unaccent');
  }
}
