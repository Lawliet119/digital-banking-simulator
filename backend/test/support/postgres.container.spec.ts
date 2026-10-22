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
    it('stops the container and cleans up process.env.DATABASE_URL and globalThis handle', async () => {
      const mockStop = jest.fn().mockResolvedValue(undefined);
      (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__ = {
        stop: mockStop,
      };
      process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';

      await stopPostgresContainer();

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(
        (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__,
      ).toBeUndefined();
    });

    it('handles cleanup gracefully when no container is running', async () => {
      delete process.env.DATABASE_URL;
      await expect(stopPostgresContainer()).resolves.toBeUndefined();
    });
  });

  describe('startPostgresContainer export', () => {
    it('TC-39-01: exports startPostgresContainer function', () => {
      expect(typeof startPostgresContainer).toBe('function');
    });
  });
});
