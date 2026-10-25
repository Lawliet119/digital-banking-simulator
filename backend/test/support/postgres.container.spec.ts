import { getContainerRuntimeClient } from 'testcontainers';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  assertDockerAvailable,
  DOCKER_CHECK_TIMEOUT_MS,
  OVERALL_START_TIMEOUT_MS,
  stopPostgresContainer,
  STARTUP_TIMEOUT_MS,
  startPostgresContainer,
} from './postgres.container';
import { requireDatabaseUrl } from './temp-database';

// The real libraries are replaced by test doubles at the library boundary, so the helper itself
// (including its own call to assertDockerAvailable) runs for real and no test touches Docker.
const mockBuilder = {
  withEnvironment: jest.fn(),
  withCommand: jest.fn(),
  withStartupTimeout: jest.fn(),
  start: jest.fn(),
};
jest.mock('testcontainers', () => ({ getContainerRuntimeClient: jest.fn() }));
jest.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: jest.fn(() => mockBuilder),
}));

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

  describe('assertDockerAvailable timeout (TC-39-08)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('gives up after 15 s when the daemon accepts the socket but never answers', async () => {
      const neverAnswers = jest.fn().mockReturnValue(new Promise(() => undefined));
      const outcome = assertDockerAvailable(neverAnswers).catch((error: Error) => error);

      await jest.advanceTimersByTimeAsync(DOCKER_CHECK_TIMEOUT_MS);
      const error = (await outcome) as Error;

      expect(DOCKER_CHECK_TIMEOUT_MS).toBe(15_000);
      expect(error.message).toMatch(/Docker is not running/);
      expect(error.message).toMatch(/within 15s/);
      expect(error.message.match(/\[Testcontainers\]/g)).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not fire early and leaves no timer behind when Docker answers', async () => {
      const answers = jest.fn().mockResolvedValue({});

      await expect(assertDockerAvailable(answers)).resolves.toBeUndefined();

      expect(jest.getTimerCount()).toBe(0);
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

  describe('startPostgresContainer (TC-39-01 config, TC-39-06, TC-39-07)', () => {
    const CONNECTION_URI = 'postgres://test:test@localhost:55432/test';
    const fakeContainer = {
      getConnectionUri: () => CONNECTION_URI,
      stop: jest.fn(),
    };
    const handle = () =>
      (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__;

    beforeEach(() => {
      jest.useFakeTimers();
      delete process.env.DATABASE_URL;
      fakeContainer.stop.mockReset().mockResolvedValue(undefined);
      (getContainerRuntimeClient as jest.Mock).mockReset().mockResolvedValue({});
      for (const method of [
        mockBuilder.withEnvironment,
        mockBuilder.withCommand,
        mockBuilder.withStartupTimeout,
      ]) {
        method.mockReset().mockReturnValue(mockBuilder);
      }
      mockBuilder.start.mockReset().mockResolvedValue(fakeContainer);
      (PostgreSqlContainer as unknown as jest.Mock).mockClear();
    });

    afterEach(() => {
      jest.useRealTimers();
      delete (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__;
    });

    it('TC-39-07(a): returns only the URL, leaves process.env alone and configures Postgres 17 in UTC', async () => {
      const started = await startPostgresContainer();

      expect(started).toStrictEqual({ databaseUrl: CONNECTION_URI });
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(handle()).toBe(fakeContainer);
      expect(PostgreSqlContainer).toHaveBeenCalledWith('postgres:17-alpine');
      expect(mockBuilder.withEnvironment).toHaveBeenCalledWith({ TZ: 'UTC' });
      expect(mockBuilder.withCommand).toHaveBeenCalledWith(['postgres', '-c', 'timezone=UTC']);
      expect(mockBuilder.withStartupTimeout).toHaveBeenCalledWith(60_000);
    });

    it('TC-39-06(c): finishing in time does not stop the container and leaves no timer', async () => {
      await startPostgresContainer();

      expect(fakeContainer.stop).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('TC-39-06(a): rejects with an actionable message once the overall 300 s are used up', async () => {
      expect(OVERALL_START_TIMEOUT_MS).toBe(300_000);
      mockBuilder.start.mockReturnValue(new Promise(() => undefined));
      const outcome = startPostgresContainer().catch((error: Error) => error);

      await jest.advanceTimersByTimeAsync(OVERALL_START_TIMEOUT_MS);
      const error = (await outcome) as Error;

      expect(error.message).toMatch(/did not become ready within 300s/);
      expect(error.message).toMatch(/docker pull postgres:17-alpine/);
      expect(handle()).toBeUndefined();
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('TC-39-06(b): stops a container that only finishes starting after the deadline', async () => {
      let finishStart: (container: unknown) => void = () => undefined;
      mockBuilder.start.mockReturnValue(
        new Promise(resolve => {
          finishStart = resolve;
        }),
      );
      const outcome = startPostgresContainer().catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(OVERALL_START_TIMEOUT_MS);
      await outcome;

      finishStart(fakeContainer);
      await jest.advanceTimersByTimeAsync(0);

      expect(fakeContainer.stop).toHaveBeenCalledTimes(1);
      expect(handle()).toBeUndefined();
    });

    it('TC-39-06(b): a failing late stop() is swallowed, not an unhandled rejection', async () => {
      let finishStart: (container: unknown) => void = () => undefined;
      mockBuilder.start.mockReturnValue(
        new Promise(resolve => {
          finishStart = resolve;
        }),
      );
      fakeContainer.stop.mockRejectedValue(new Error('stop failed'));
      const outcome = startPostgresContainer().catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(OVERALL_START_TIMEOUT_MS);
      await outcome;

      finishStart(fakeContainer);
      await jest.advanceTimersByTimeAsync(0);

      expect(fakeContainer.stop).toHaveBeenCalledTimes(1);
    });
  });
});
