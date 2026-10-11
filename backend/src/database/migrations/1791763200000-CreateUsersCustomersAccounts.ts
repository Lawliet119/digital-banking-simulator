import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 1 (database-design §4.1, §4.2, §11): users, customers, accounts and the one SYSTEM
 * `funding` account deposits come from (ADR-09).
 *
 * Constraint names are spelled out so tests and error handling can rely on them. Foreign keys are
 * RESTRICT on purpose: a bank does not delete history in cascade (database-design rule 8).
 */
export class CreateUsersCustomersAccounts1791763200000 implements MigrationInterface {
  name = 'CreateUsersCustomersAccounts1791763200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // No email or phone: Cognito holds identity; the role lives only in the JWT groups.
    await queryRunner.query(`
      CREATE TABLE users (
        id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
        cognito_sub         text        NOT NULL,
        sessions_revoked_at timestamptz,
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_pkey PRIMARY KEY (id),
        CONSTRAINT users_cognito_sub_key UNIQUE (cognito_sub)
      )`);

    await queryRunner.query(`
      CREATE TABLE customers (
        id         uuid        NOT NULL DEFAULT gen_random_uuid(),
        user_id    uuid        NOT NULL,
        full_name  text        NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT customers_pkey PRIMARY KEY (id),
        CONSTRAINT customers_user_id_key UNIQUE (user_id),
        CONSTRAINT customers_user_id_fkey FOREIGN KEY (user_id)
          REFERENCES users (id) ON DELETE RESTRICT
      )`);

    // fillfactor 80 leaves room on each page so the frequent balance UPDATEs stay HOT (§9);
    // for the same reason balance and status are not indexed.
    await queryRunner.query(`
      CREATE TABLE accounts (
        id          uuid        NOT NULL DEFAULT gen_random_uuid(),
        customer_id uuid,
        type        text        NOT NULL,
        status      text        NOT NULL DEFAULT 'ACTIVE',
        balance     bigint      NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT accounts_pkey PRIMARY KEY (id),
        CONSTRAINT accounts_customer_id_fkey FOREIGN KEY (customer_id)
          REFERENCES customers (id) ON DELETE RESTRICT,
        CONSTRAINT accounts_type_check CHECK (type IN ('CHECKING', 'SAVINGS', 'SYSTEM')),
        CONSTRAINT accounts_status_check CHECK (status IN ('ACTIVE', 'LOCKED')),
        CONSTRAINT accounts_balance_non_negative CHECK (type = 'SYSTEM' OR balance >= 0),
        CONSTRAINT accounts_owner_matches_type CHECK ((type = 'SYSTEM') = (customer_id IS NULL))
      ) WITH (fillfactor = 80)`);

    // Exactly one SYSTEM account. Moving to several funding accounts (ADR-09 option C) drops this.
    await queryRunner.query(
      `CREATE UNIQUE INDEX accounts_single_system ON accounts (type) WHERE type = 'SYSTEM'`,
    );
    // A customer's accounts (UC-4) and the count when opening one (BR-14).
    await queryRunner.query(
      `CREATE INDEX accounts_customer_idx ON accounts (customer_id) WHERE customer_id IS NOT NULL`,
    );

    // The fixed id is a literal, not an imported constant: a migration is history and must not
    // change if code is renamed later.
    await queryRunner.query(`
      INSERT INTO accounts (id, customer_id, type, status, balance)
      VALUES ('00000000-0000-4000-8000-000000000001', NULL, 'SYSTEM', 'ACTIVE', 0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE accounts');
    await queryRunner.query('DROP TABLE customers');
    await queryRunner.query('DROP TABLE users');
  }
}
