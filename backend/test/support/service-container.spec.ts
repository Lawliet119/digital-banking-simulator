import type { StartedTestContainer } from 'testcontainers';
import { startServiceContainer } from './service-container';
import { OVERALL_START_TIMEOUT_MS } from './postgres.container';

describe('DBS-40 service container failure cleanup', () => {
  it('TC-40-05: stops a container that starts after the overall deadline', async () => {
    jest.useFakeTimers();
    try {
      let finish!: (container: StartedTestContainer) => void;
      const starting = new Promise<StartedTestContainer>(resolve => {
        finish = resolve;
      });
      const stopped = jest.fn().mockResolvedValue(undefined);
      const outcome = startServiceContainer('Valkey', starting, () => Promise.resolve()).catch(
        (error: Error) => error,
      );
      await jest.advanceTimersByTimeAsync(OVERALL_START_TIMEOUT_MS);
      expect(((await outcome) as Error).message).toMatch(/Valkey did not start within 300s/);
      finish({ stop: stopped } as unknown as StartedTestContainer);
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('TC-40-05: stops the container when the protocol probe fails', async () => {
    const stopped = jest.fn().mockResolvedValue(undefined);
    const container = { stop: stopped } as unknown as StartedTestContainer;
    await expect(
      startServiceContainer('ElasticMQ', Promise.resolve(container), () =>
        Promise.reject(new Error('queue missing')),
      ),
    ).rejects.toThrow('queue missing');
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
