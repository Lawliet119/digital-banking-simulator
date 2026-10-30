import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { getContainerRuntimeClient, type StartedTestContainer } from 'testcontainers';
import { controlService, startServiceContainer, stillPendingAfter } from './service-container';
import { DOCKER_CHECK_TIMEOUT_MS, OVERALL_START_TIMEOUT_MS } from './postgres.container';
import { ELASTICMQ_PROBE_TIMEOUT_MS } from './elasticmq.container';

jest.mock('testcontainers', () => {
  // @testcontainers/postgresql (imported transitively via ./postgres.container) extends a real
  // class from 'testcontainers', so the mock must keep every other real export and override only
  // getContainerRuntimeClient — replacing the whole module breaks that extends clause.
  const actual = jest.requireActual<typeof import('testcontainers')>('testcontainers');
  return { ...actual, getContainerRuntimeClient: jest.fn() };
});

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

  it('TC-40-07 (DBS-40 vòng 2): trả { container, probeResult } khi probe thành công', async () => {
    const container = { stop: jest.fn() } as unknown as StartedTestContainer;
    const result = await startServiceContainer('Valkey', Promise.resolve(container), () =>
      Promise.resolve('/risk-events'),
    );
    expect(result).toEqual({ container, probeResult: '/risk-events' });
  });

  it('TC-40-07 (DBS-40 vòng 2): khi probe timeout bắn, AbortSignal truyền vào probe được abort trước khi stop()', async () => {
    jest.useFakeTimers();
    try {
      const order: string[] = [];
      const stopped = jest.fn(() => {
        order.push('stop');
      });
      const container = { stop: stopped } as unknown as StartedTestContainer;
      const probe = (_container: StartedTestContainer, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('abort');
            reject(new Error('probe aborted'));
          });
        });
      const outcome = startServiceContainer(
        'Valkey',
        Promise.resolve(container),
        probe,
        5_000,
      ).catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      const error = (await outcome) as Error;
      expect(error.message).toMatch(/Valkey protocol probe timed out/);
      expect(order).toEqual(['abort', 'stop']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('stillPendingAfter (TC-40-10, DBS-40 vòng 2)', () => {
  it('trả true khi probe còn treo sau ms', async () => {
    jest.useFakeTimers();
    try {
      const pending = new Promise<void>(() => undefined);
      const outcome = stillPendingAfter(pending, 500);
      await jest.advanceTimersByTimeAsync(500);
      expect(await outcome).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('trả false khi probe resolve trước ms', async () => {
    await expect(stillPendingAfter(Promise.resolve('PONG'), 500)).resolves.toBe(false);
  });

  it('trả false khi probe reject trước ms (không ném lỗi ra ngoài Promise.race)', async () => {
    await expect(
      stillPendingAfter(Promise.reject(new Error('connection reset')), 500),
    ).resolves.toBe(false);
  });
});

describe('controlService memoization (TC-40-11, DBS-40 vòng 2)', () => {
  it('gọi getContainerRuntimeClient() đúng một lần dù pause()/resume() được gọi nhiều lần', async () => {
    const pause = jest.fn().mockResolvedValue(undefined);
    const unpause = jest.fn().mockResolvedValue(undefined);
    const getById = jest.fn().mockReturnValue({ pause, unpause });
    (getContainerRuntimeClient as jest.Mock).mockReset().mockResolvedValue({
      container: { getById },
    });
    const container = { getId: () => 'abc123' } as unknown as StartedTestContainer;
    const service = controlService(container);

    await service.pause();
    await service.resume();
    await service.pause();

    expect(getContainerRuntimeClient).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledTimes(1);
  });
});

describe('TC-40-12 (DBS-40 vòng 2): ngân sách testTimeout của test:services đủ cho ca xấu nhất', () => {
  it('(DOCKER_CHECK_TIMEOUT_MS + OVERALL_START_TIMEOUT_MS + ELASTICMQ_PROBE_TIMEOUT_MS) * 2 < testTimeout', () => {
    // jest-services.js là CommonJS thuần (không có allowJs trong tsconfig), nên đọc testTimeout
    // bằng regex trên file thật thay vì import/require nó — vẫn chứng minh hai hằng số không
    // lệch nhau khi một trong hai đổi mà quên cập nhật cái còn lại.
    const jestServicesSource = readFileSync(resolvePath(__dirname, '../jest-services.js'), 'utf8');
    const match = /testTimeout:\s*([\d_]+)/.exec(jestServicesSource);
    if (!match) throw new Error('jest-services.js không có testTimeout để đối chiếu');
    const testTimeout = Number(match[1].replace(/_/g, ''));

    expect(DOCKER_CHECK_TIMEOUT_MS).toBe(15_000);
    expect(OVERALL_START_TIMEOUT_MS).toBe(300_000);
    expect(ELASTICMQ_PROBE_TIMEOUT_MS).toBe(150_000);
    expect(testTimeout).toBe(1_080_000);

    const worstCaseElasticMq =
      (DOCKER_CHECK_TIMEOUT_MS + OVERALL_START_TIMEOUT_MS + ELASTICMQ_PROBE_TIMEOUT_MS) * 2;
    expect(worstCaseElasticMq).toBe(930_000);
    expect(worstCaseElasticMq).toBeLessThan(testTimeout);
  });
});
