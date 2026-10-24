import {
  assertDockerAvailable,
  stopPostgresContainer,
  STARTUP_TIMEOUT_MS,
  startPostgresContainer,
} from './postgres.container';
import { requireDatabaseUrl } from './temp-database';

describe('postgres.container and test harness helpers', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  describe('STARTUP_TIMEOUT_MS', () => {
    it('enforces startup timeout of 60 seconds (DoD #4)', () => {
      expect(STARTUP_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe('assertDockerAvailable', () => {
    it('TC-39-03: throws clear, actionable error when Docker runtime is not available', async () => {
      const mockGetRuntimeClient = jest
        .fn()
        .mockRejectedValue(new Error('Cannot connect to Docker'));
      await expect(assertDockerAvailable(mockGetRuntimeClient)).rejects.toThrow(
        /\[Testcontainers\] Docker is not running or unreachable\. Please start Docker Desktop/i,
      );
    });

    it('TC-39-03: resolves cleanly when Docker runtime is available', async () => {
      const mockGetRuntimeClient = jest.fn().mockResolvedValue({});
      await expect(assertDockerAvailable(mockGetRuntimeClient)).resolves.toBeUndefined();
    });
  });

  describe('requireDatabaseUrl', () => {
    it('throws actionable error when DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;
      expect(() => requireDatabaseUrl()).toThrow(
        /DATABASE_URL is not set\. Ensure Jest globalSetup \(Testcontainers\) has run/i,
      );
    });

    it('returns the URL when DATABASE_URL is present', () => {
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
      expect(requireDatabaseUrl()).toBe('postgresql://test:test@localhost:5432/test_db');
    });
  });

  describe('stopPostgresContainer (TC-39-04)', () => {
    const handle = () =>
      (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__;
    const setHandle = (value: unknown) => {
      (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__ =
        value;
    };

    afterEach(() => {
      setHandle(undefined);
    });

    it('stops the container and cleans up process.env.DATABASE_URL and globalThis handle', async () => {
      const mockStop = jest.fn().mockResolvedValue(undefined);
      setHandle({ stop: mockStop });
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';

      await stopPostgresContainer();

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(handle()).toBeUndefined();
    });

    it('still clears the handle and DATABASE_URL when stop() rejects, and surfaces the error', async () => {
      const mockStop = jest.fn().mockRejectedValue(new Error('stop failed'));
      setHandle({ stop: mockStop });
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';

      await expect(stopPostgresContainer()).rejects.toThrow('stop failed');

      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(handle()).toBeUndefined();
    });

    it('leaves an externally supplied DATABASE_URL alone when this run started no container', async () => {
      process.env.DATABASE_URL = 'postgresql://ci:ci@db.example:5432/banking';

      await expect(stopPostgresContainer()).resolves.toBeUndefined();

      expect(process.env.DATABASE_URL).toBe('postgresql://ci:ci@db.example:5432/banking');
    });
  });

  describe('startPostgresContainer export', () => {
    it('TC-39-01: exports startPostgresContainer function', () => {
      expect(typeof startPostgresContainer).toBe('function');
    });
  });
});
