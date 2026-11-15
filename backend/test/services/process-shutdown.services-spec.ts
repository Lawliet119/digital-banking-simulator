import {
  buildAppImage,
  forContainer,
  removeImage,
  startApp,
  type AppEnvironment,
  type StartedApp,
} from '../support/app-container';
import { startElasticMqContainer, type StartedElasticMq } from '../support/elasticmq.container';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

/** `docker stop -t`: the grace period before SIGKILL. ECS gives the worker 60 s (`stopTimeout`). */
const GRACE_SECONDS = 20;
/** A clean exit takes well under a second; anything near the grace period is a kill. */
const CLEAN_EXIT_MS = 5_000;

/**
 * BL-384: a process that gets SIGTERM must exit by itself. The production image runs
 * `node dist/main.js` as PID 1, and the kernel ignores a signal that PID 1 has no handler for. Nest
 * ends its shutdown by sending the signal to the process again, so unless the process exits
 * explicitly it is only ever ended by SIGKILL (exit 137) after the grace period.
 *
 * The test runs the real image with Node as PID 1. Run in the Jest process, or as a plain
 * `node dist/main.js`, it cannot fail this way, which is why `consumer-shutdown.services-spec.ts`
 * did not catch it.
 */
describe('BL-384 the api and the worker exit on SIGTERM (production image, real services)', () => {
  let image: string;
  let db: TempDatabase;
  let valkey: StartedValkey;
  let mq: StartedElasticMq;
  let env: AppEnvironment;
  const started: StartedApp[] = [];

  beforeAll(async () => {
    [valkey, mq] = await Promise.all([startValkeyContainer(), startElasticMqContainer()]);
    db = await createTempDatabase();
    await migrate(db.url);
    image = await buildAppImage();
    const queue = (name: string): string => forContainer(new URL(name, mq.endpoint).toString());
    env = {
      databaseUrl: forContainer(db.url),
      redisUrl: forContainer(valkey.url),
      sqsEndpoint: forContainer(mq.endpoint).replace(/\/$/, ''),
      riskQueueUrl: queue('/000000000000/risk-events'),
      notificationQueueUrl: queue('/000000000000/notification-events'),
    };
  });

  afterAll(async () => {
    await Promise.all(started.map(app => app.remove()));
    if (image) await removeImage(image);
    await db?.drop();
    await Promise.all([valkey?.stop(), mq?.stop()]);
  });

  it('TC-384-01 the worker exits 0 within seconds of SIGTERM', async () => {
    const worker = await startApp(image, 'worker', env);
    started.push(worker);
    await worker.ready(/Worker started/);

    const { elapsedMs, exitCode } = await worker.stop(GRACE_SECONDS);

    // 137 = SIGKILL after the grace period: the process never ended itself.
    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(CLEAN_EXIT_MS);
  });

  it('TC-384-02 the api exits 0 within seconds of SIGTERM (control)', async () => {
    const api = await startApp(image, 'api', env);
    started.push(api);
    await api.ready(/HTTP listener started/);

    const { elapsedMs, exitCode } = await api.stop(GRACE_SECONDS);

    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(CLEAN_EXIT_MS);
  });
});
