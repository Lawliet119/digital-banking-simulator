import { validateEnv } from './validation.schema';

const parts = {
  DB_HOST: 'db.example.internal',
  DB_PORT: '5432',
  DB_NAME: 'dbs',
  DB_USER: 'dbs_master',
  DB_PASSWORD: 'p@ss/word',
};

describe('env.bootstrap (TC-67-06)', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  function bootstrap(env: Record<string, string>): void {
    process.env = { NODE_ENV: 'test', ...env };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./env.bootstrap');
    });
  }

  it('sets DATABASE_URL from the DB_* parts', () => {
    bootstrap(parts);
    expect(process.env.DATABASE_URL).toBe(
      'postgresql://dbs_master:p%40ss%2Fword@db.example.internal:5432/dbs',
    );
  });

  it('leaves an existing DATABASE_URL alone', () => {
    bootstrap({ ...parts, DATABASE_URL: 'postgres://u:p@localhost/banking' });
    expect(process.env.DATABASE_URL).toBe('postgres://u:p@localhost/banking');
  });

  it('sets nothing for a partial set and names only the variables on stderr', () => {
    const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    bootstrap({ ...parts, DB_PORT: 'abc' });
    expect(process.env.DATABASE_URL).toBeUndefined();
    const output = write.mock.calls.map(call => String(call[0])).join('');
    expect(output).toContain('DB_PORT');
    expect(output).not.toContain('p@ss/word');
    expect(output).not.toContain('p%40ss');
  });

  it('stays silent when DB_HOST is not configured', () => {
    const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    bootstrap({});
    expect(write).not.toHaveBeenCalled();
  });

  describe('with the schema', () => {
    const rest = {
      REDIS_URL: 'redis://localhost:6379',
      SQS_RISK_QUEUE_URL: 'http://localhost:9324/000000000000/risk-events',
      SQS_NOTIFICATION_QUEUE_URL: 'http://localhost:9324/000000000000/notification-events',
    };

    it('accepts the DB_* parts next to a composed DATABASE_URL', () => {
      bootstrap(parts);
      expect(() => validateEnv({ ...rest, ...process.env })).not.toThrow();
    });

    it('still demands DATABASE_URL when the parts could not be composed', () => {
      bootstrap({ ...parts, DB_PASSWORD: '' });
      expect(() => validateEnv({ ...rest, ...parts, DB_PASSWORD: '' })).toThrow(/DATABASE_URL/);
    });
  });

  describe('REDIS_URL from the REDIS_* parts (TC-75-09)', () => {
    const redisParts = {
      REDIS_HOST: 'master.dbs-dev.abc123.apse1.cache.amazonaws.com',
      REDIS_PORT: '6379',
      REDIS_AUTH_TOKEN: 'Q7rVd2kLm9XwTz4bN8pYh3sJc6fGa1uE',
    };

    it('sets REDIS_URL from the parts', () => {
      bootstrap(redisParts);
      expect(process.env.REDIS_URL).toBe(
        'rediss://:Q7rVd2kLm9XwTz4bN8pYh3sJc6fGa1uE@master.dbs-dev.abc123.apse1.cache.amazonaws.com:6379',
      );
    });

    it('leaves an existing REDIS_URL alone', () => {
      bootstrap({ ...redisParts, REDIS_URL: 'redis://localhost:6379' });
      expect(process.env.REDIS_URL).toBe('redis://localhost:6379');
    });

    it('sets nothing for a partial set and names only the variables on stderr', () => {
      const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      bootstrap({ ...redisParts, REDIS_PORT: 'abc' });
      expect(process.env.REDIS_URL).toBeUndefined();
      const output = write.mock.calls.map(call => String(call[0])).join('');
      expect(output).toContain('REDIS_PORT');
      expect(output).not.toContain(redisParts.REDIS_AUTH_TOKEN);
      expect(output).not.toContain(encodeURIComponent(redisParts.REDIS_AUTH_TOKEN));
    });

    it('stays silent when REDIS_HOST is not configured', () => {
      const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
      bootstrap({ REDIS_URL: 'redis://localhost:6379' });
      expect(write).not.toHaveBeenCalled();
    });

    it('lets a staging config with only the DB_* and REDIS_* parts pass the schema', () => {
      const staging = {
        NODE_ENV: 'staging',
        DATABASE_SSL: 'true',
        TRUST_PROXY_HOPS: '1',
        APP_ROLE: 'api',
        COGNITO_USER_POOL_ID: 'ap-southeast-1_abc',
        COGNITO_CLIENT_ID: 'client-id',
        COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_abc',
      };
      bootstrap({ ...staging, ...parts, ...redisParts });
      expect(() => validateEnv({ ...process.env })).not.toThrow();
    });
  });
});
