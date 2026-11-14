import {
  DB_ROLES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_ENV,
  provisionDbRoles,
  provisionStatements,
  readPasswords,
  scramVerifier,
  type DbRole,
  type ProvisionDeps,
} from './provision-db-roles';

const passwords: Record<DbRole, string> = {
  dbs_api: 'a'.repeat(32),
  dbs_worker: 'b'.repeat(32),
  dbs_migrator: 'c'.repeat(32),
};

const envOf = (values: Record<DbRole, string | undefined>): NodeJS.ProcessEnv =>
  Object.fromEntries(DB_ROLES.map(role => [PASSWORD_ENV[role], values[role]]));

describe('BL-103 provision-db-roles', () => {
  describe('scramVerifier', () => {
    it('has the PostgreSQL SCRAM-SHA-256 shape and never contains the password', () => {
      const verifier = scramVerifier('S3cretPassw0rdS3cretPassw0rd');
      expect(verifier).toMatch(
        /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
      );
      expect(verifier).not.toContain('S3cretPassw0rd');
    });

    it('is deterministic for a salt and differs between salts', () => {
      const salt = Buffer.alloc(16, 7);
      expect(scramVerifier('p'.repeat(24), salt)).toBe(scramVerifier('p'.repeat(24), salt));
      expect(scramVerifier('p'.repeat(24))).not.toBe(scramVerifier('p'.repeat(24)));
    });
  });

  describe('readPasswords', () => {
    it('accepts three distinct alphanumeric passwords', () => {
      expect(readPasswords(envOf(passwords))).toEqual(passwords);
    });

    it('names the missing variable and never prints a value', () => {
      const run = () => readPasswords(envOf({ ...passwords, dbs_worker: undefined }));
      expect(run).toThrow('DBS_WORKER_DB_PASSWORD is missing');
    });

    it('rejects a short or non-alphanumeric password without echoing it', () => {
      const short = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
      const quote = `${'y'.repeat(30)}'; DROP ROLE x; --`;
      for (const bad of [short, quote]) {
        try {
          readPasswords(envOf({ ...passwords, dbs_api: bad }));
          throw new Error('expected a rejection');
        } catch (error) {
          expect((error as Error).message).toContain('DBS_API_DB_PASSWORD must be at least');
          expect((error as Error).message).not.toContain(bad);
        }
      }
    });

    it('rejects two roles sharing a password', () => {
      expect(() => readPasswords(envOf({ ...passwords, dbs_worker: passwords.dbs_api }))).toThrow(
        'must differ',
      );
    });
  });

  describe('provisionStatements', () => {
    const verifiers = {
      dbs_api: 'SCRAM-SHA-256$4096:AAAA$BBBB:CCCC',
      dbs_worker: 'SCRAM-SHA-256$4096:DDDD$EEEE:FFFF',
      dbs_migrator: 'SCRAM-SHA-256$4096:GGGG$HHHH:IIII',
    };

    it('creates the roles first, sets one verifier per role, then grants and adopts', () => {
      const statements = provisionStatements(verifiers);
      expect(statements[0]).toContain('CREATE ROLE dbs_migrator NOLOGIN NOSUPERUSER');
      expect(statements.slice(1, 4)).toEqual([
        "ALTER ROLE dbs_api LOGIN PASSWORD 'SCRAM-SHA-256$4096:AAAA$BBBB:CCCC'",
        "ALTER ROLE dbs_worker LOGIN PASSWORD 'SCRAM-SHA-256$4096:DDDD$EEEE:FFFF'",
        "ALTER ROLE dbs_migrator LOGIN PASSWORD 'SCRAM-SHA-256$4096:GGGG$HHHH:IIII'",
      ]);
      expect(statements[4]).toContain('GRANT USAGE, CREATE ON SCHEMA public TO dbs_migrator');
      expect(statements[4]).toContain('GRANT CREATE ON DATABASE %I TO dbs_migrator');
      expect(statements[5]).toContain('OWNER TO dbs_migrator');
    });

    it('gives the application roles no table privilege and no superuser attribute', () => {
      const sql = provisionStatements(verifiers).join('\n');
      expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)/);
      // Only the NO-forms (NOSUPERUSER, NOCREATEDB, NOCREATEROLE) may appear.
      expect(sql).not.toMatch(/(?<![A-Z])(SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS|REPLICATION)/);
    });
  });

  describe('provisionDbRoles', () => {
    function deps(overrides: Partial<ProvisionDeps> = {}) {
      const sent: string[] = [];
      const logs: string[] = [];
      const logins: string[] = [];
      const value: ProvisionDeps = {
        master: {
          query: (sql: string) => {
            sent.push(sql);
            return Promise.resolve([]);
          },
        },
        passwords,
        log: line => logs.push(line),
        loginAs: (role, password) => {
          logins.push(`${role}:${password}`);
          return Promise.resolve(role);
        },
        ...overrides,
      };
      return { value, sent, logs, logins };
    }

    it('runs everything in one transaction, then logs in as each role', async () => {
      const { value, sent, logins } = deps();
      await provisionDbRoles(value);
      expect(sent[0]).toBe('BEGIN');
      expect(sent[sent.length - 1]).toBe('COMMIT');
      expect(sent.filter(sql => sql.startsWith('ALTER ROLE'))).toHaveLength(3);
      expect(logins).toEqual(DB_ROLES.map(role => `${role}:${passwords[role]}`));
    });

    it('sends and logs no plain password, only verifiers', async () => {
      const { value, sent, logs } = deps();
      await provisionDbRoles(value);
      for (const password of Object.values(passwords)) {
        expect(sent.join('\n')).not.toContain(password);
        expect(logs.join('\n')).not.toContain(password);
      }
      expect(sent.join('\n')).toContain('SCRAM-SHA-256$4096:');
    });

    it('rolls back and rethrows when a statement fails, without logging in', async () => {
      const sent: string[] = [];
      const { value, logins } = deps({
        master: {
          query: (sql: string) => {
            sent.push(sql);
            return sql.startsWith('ALTER ROLE dbs_worker')
              ? Promise.reject(new Error('boom'))
              : Promise.resolve([]);
          },
        },
      });
      await expect(provisionDbRoles(value)).rejects.toThrow('boom');
      expect(sent[sent.length - 1]).toBe('ROLLBACK');
      expect(sent).not.toContain('COMMIT');
      expect(logins).toEqual([]);
    });

    it('fails when a login answers as another user', async () => {
      const { value } = deps({ loginAs: () => Promise.resolve('postgres') });
      await expect(provisionDbRoles(value)).rejects.toThrow(/returned current_user postgres/);
    });
  });
});
