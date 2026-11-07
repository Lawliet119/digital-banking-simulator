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
});
