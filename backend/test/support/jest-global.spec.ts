import { getContainerRuntimeClient } from 'testcontainers';
import globalSetup from './jest-global-setup';

// Same library-boundary doubles as postgres.container.spec.ts: the real helper and the real
// globalSetup run, nothing reaches Docker.
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

describe('jest globalSetup', () => {
  const CONNECTION_URI = 'postgres://test:test@localhost:55432/test';
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    (getContainerRuntimeClient as jest.Mock).mockReset().mockResolvedValue({});
    for (const method of [
      mockBuilder.withEnvironment,
      mockBuilder.withCommand,
      mockBuilder.withStartupTimeout,
    ]) {
      method.mockReset().mockReturnValue(mockBuilder);
    }
    mockBuilder.start
      .mockReset()
      .mockResolvedValue({ getConnectionUri: () => CONNECTION_URI, stop: jest.fn() });
  });

  afterEach(() => {
    delete (globalThis as unknown as { __POSTGRES_CONTAINER__?: unknown }).__POSTGRES_CONTAINER__;
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it('TC-39-07(b): without DATABASE_URL it starts one container and assigns the URL once', async () => {
    await globalSetup();

    expect(mockBuilder.start).toHaveBeenCalledTimes(1);
    expect(process.env.DATABASE_URL).toBe(CONNECTION_URI);
  });

  it('TC-39-07(c): with DATABASE_URL already set it starts nothing and keeps the value', async () => {
    process.env.DATABASE_URL = 'postgres://ci:ci@db.example:5432/banking';

    await globalSetup();

    expect(getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mockBuilder.start).not.toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBe('postgres://ci:ci@db.example:5432/banking');
  });

  it('TC-39-03: with Docker unreachable it fails with the Docker message and starts no container', async () => {
    (getContainerRuntimeClient as jest.Mock).mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(globalSetup()).rejects.toThrow(/\[Testcontainers\] Docker is not running/);

    expect(mockBuilder.start).not.toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBeUndefined();
  });
});
