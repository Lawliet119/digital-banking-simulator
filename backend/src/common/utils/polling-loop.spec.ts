import { Writable } from 'node:stream';
import { PinoLogger } from 'nestjs-pino';
import { createLoggingOptions } from '@common/logging/logging.options';
import { PollingLoop } from './polling-loop';

describe('PollingLoop', () => {
  it('runs the step again at once while it asks for no delay, and stops when told to', async () => {
    let runs = 0;
    const loop = new PollingLoop(
      () => {
        runs += 1;
        return Promise.resolve(runs < 3 ? 0 : 60_000);
      },
      () => undefined,
    );
    loop.start();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(runs).toBe(3);
    // It is now waiting 60 s; stop() must cancel that wait instead of hanging for a minute.
    await loop.stop();
    expect(loop.isRunning).toBe(false);
    expect(runs).toBe(3);
  });

  it('reports a failing step, waits the error delay and keeps going', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const loop = new PollingLoop(
      () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error('down')) : Promise.resolve(60_000);
      },
      error => errors.push(error),
      5,
    );
    loop.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(runs).toBe(2);
  });

  it('survives an error reporter that throws', async () => {
    let runs = 0;
    const loop = new PollingLoop(
      () => {
        runs += 1;
        return runs === 1 ? Promise.reject(new Error('x')) : Promise.resolve(60_000);
      },
      () => {
        throw new Error('reporter broke');
      },
      1,
    );
    loop.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    await loop.stop();
    expect(runs).toBe(2);
  });

  describe('BL-024 logging context of a background job', () => {
    let output = '';
    let pino: PinoLogger;

    beforeAll(() => {
      const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          output += chunk.toString();
          done();
        },
      });
      pino = new PinoLogger({
        pinoHttp: [createLoggingOptions({ role: 'both', logLevel: 'verbose' }), stream],
      });
    });
    beforeEach(() => {
      output = '';
    });

    it('logs from the step and from the error reporter with role=worker under APP_ROLE=both', async () => {
      let runs = 0;
      const loop = new PollingLoop(
        async () => {
          runs += 1;
          await new Promise(resolve => setImmediate(resolve));
          pino.logger.info('Step ran');
          if (runs === 1) throw new Error('down');
          return 60_000;
        },
        () => pino.logger.warn('Step failed'),
        1,
      );
      loop.start();
      // Wait for the third line instead of a fixed time: a loaded machine runs this slowly.
      for (let wait = 0; wait < 200 && output.trim().split('\n').length < 3; wait++)
        await new Promise(resolve => setTimeout(resolve, 10));
      await loop.stop();
      const rows = output
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>);
      expect(rows.map(row => row.message)).toEqual(['Step ran', 'Step failed', 'Step ran']);
      for (const row of rows)
        expect(row).toMatchObject({ appRole: 'both', role: 'worker', correlationId: null });
    });

    it('does not move the caller of start() into the worker context', async () => {
      const loop = new PollingLoop(
        () => Promise.resolve(60_000),
        () => undefined,
      );
      loop.start();
      pino.logger.info('Caller line');
      await loop.stop();
      expect(JSON.parse(output.trim()) as unknown).toMatchObject({ role: 'api' });
    });
  });
});
