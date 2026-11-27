import { createServer, request, Agent, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { drainHttp } from './graceful-shutdown';
import { InflightRequests } from './inflight-requests';

/**
 * BL-381: the waiting rules of the drain, on a real HTTP server. The behaviour of the whole process
 * under SIGTERM is `test/services/api-shutdown.services-spec.ts`.
 */
describe('drainHttp', () => {
  let server: Server;
  let requests: InflightRequests;
  let url: string;
  /** Finishes the oldest handler: answers it (if the caller is still there) and stops counting it. */
  let finish: (() => void)[];
  let arrived: () => void;

  beforeEach(async () => {
    requests = new InflightRequests();
    finish = [];
    server = createServer((_req, res: ServerResponse) => {
      const done = requests.begin(res);
      finish.push(() => {
        done();
        res.end('ok');
      });
      arrived();
    });
    server.keepAliveTimeout = 65_000;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  /** One request that is inside its handler when this resolves. */
  async function inHandler(agent: Agent | false = false) {
    const reached = new Promise<void>(resolve => (arrived = resolve));
    const call = request(url, { agent });
    const answer = new Promise<{ status: number; connection?: string }>((resolve, reject) => {
      call.on('response', res => {
        res.resume();
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }),
        );
      });
      call.on('error', reject);
    });
    answer.catch(() => undefined);
    call.end();
    await reached;
    return { call, answer };
  }

  const settledWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([
      promise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms)),
    ]);

  it('returns at once when nothing is running', async () => {
    await expect(drainHttp(server, requests, 5_000)).resolves.toBe(0);
    expect(server.listening).toBe(false);
  });

  it('waits for the running request, answers it with Connection: close, refuses new ones', async () => {
    const agent = new Agent({ keepAlive: true });
    const running = await inHandler(agent);
    const drained = drainHttp(server, requests, 5_000);
    expect(await settledWithin(drained, 200)).toBe(false);
    await expect(
      new Promise((resolve, reject) => {
        const call = request(url, { agent: false }, resolve);
        call.on('error', reject);
        call.end();
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    finish[0]();

    await expect(running.answer).resolves.toEqual({ status: 200, connection: 'close' });
    // Well before the 65 s keep-alive timeout and the drain limit.
    await expect(drained).resolves.toBe(0);
    agent.destroy();
  });

  it('keeps waiting for a handler whose caller has hung up', async () => {
    const running = await inHandler();
    running.call.destroy();
    const drained = drainHttp(server, requests, 5_000);

    expect(await settledWithin(drained, 300)).toBe(false);
    finish[0]();

    await expect(drained).resolves.toBe(0);
  });

  it('gives up at the limit, cuts the connection and says how many were left', async () => {
    const running = await inHandler();
    const started = Date.now();

    await expect(drainHttp(server, requests, 300)).resolves.toBe(1);

    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    await expect(running.answer).rejects.toBeDefined();
  });
});
