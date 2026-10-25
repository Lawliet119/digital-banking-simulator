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
});
