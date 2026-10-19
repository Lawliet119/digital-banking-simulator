import {
  startPostgresContainer,
  stopPostgresContainer,
  assertDockerAvailable,
} from './postgres.container';

describe('postgres.container helper', () => {
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

  describe('startPostgresContainer & stopPostgresContainer exports', () => {
    it('TC-39-01, TC-39-04: exports start and stop helper functions', () => {
      expect(typeof startPostgresContainer).toBe('function');
      expect(typeof stopPostgresContainer).toBe('function');
    });
  });
});
