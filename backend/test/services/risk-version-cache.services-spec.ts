import { createServer, connect, type Socket } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { createClient, type RedisClientType } from 'redis';
import { RedisClient, RedisMetrics } from '@libs/redis';
import { withTimeout } from '../support/postgres.container';
import { startValkeyContainer, type StartedValkey } from '../support/valkey.container';

describe('risk configuration publication on Valkey', () => {
  let valkey: StartedValkey;
  let client: RedisClient;
  let admin: RedisClientType;
  const key = 'dbs110:latest-test';
  beforeAll(async () => {
    valkey = await startValkeyContainer();
    admin = createClient({ url: valkey.url });
    admin.on('error', () => undefined);
    await admin.connect();
    client = new RedisClient({ url: valkey.url, commandTimeoutMs: 50 }, new RedisMetrics());
    const deadline = Date.now() + 5000;
    while (!client.isReady) {
      if (Date.now() > deadline) throw new Error('Valkey not ready');
      await wait(10);
    }
  });
  afterEach(async () => {
    await admin.del([key, 'dbs110:immutable-test']);
  });
  afterAll(async () => {
    client?.onModuleDestroy();
    if (admin?.isOpen) admin.destroy();
    await valkey?.stop();
  });

  it('never replaces a newer version with a delayed or expired one', async () => {
    const now = await client.serverTimeMs();
    expect(await client.setVersionBefore(key, 2, now + 5000)).toBe(true);
    expect(await client.setVersionBefore(key, 1, now + 5000)).toBe(false);
    expect(await client.setVersionBefore(key, 3, now - 1)).toBe(false);
    expect((await client.readExpiringVersion(key))?.version).toBe(2);
    expect(await admin.pTTL(key)).toBeLessThanOrEqual(5000);
  });

  it('repairs wrong-type and improperly extended latest keys without touching immutable content', async () => {
    const deadline = (await client.serverTimeMs()) + 5000;
    await admin.lPush(key, 'wrong-type');
    await expect(client.readExpiringVersion(key)).rejects.toMatchObject({ reason: 'CORRUPT' });
    expect(await client.setVersionBefore(key, 1, deadline)).toBe(true);
    await admin.set(key, `2:${deadline}`, { PX: 30_000 });
    await expect(client.readExpiringVersion(key)).rejects.toMatchObject({ reason: 'CORRUPT' });
    expect(await client.setVersionBefore(key, 1, deadline)).toBe(true);
    expect((await client.readExpiringVersion(key))?.version).toBe(1);
    expect(await client.setIfAbsent('dbs110:immutable-test', 'first', 60)).toBe(true);
    expect(await client.setIfAbsent('dbs110:immutable-test', 'second', 60)).toBe(false);
    expect(await client.get('dbs110:immutable-test')).toBe('first');
  });

  it('BL-208 reports a marker nobody wrote as corrupt, an absent or expired one as a plain miss', async () => {
    const deadline = (await client.serverTimeMs()) + 5000;
    const junk = [
      '9999999999', // the bare legacy form of latest, out of int4 range
      `9999999999:${deadline}`, // int4 overflow
      `2147483648:${deadline}`,
      'not-a-marker',
      `0:${deadline}`,
    ];
    for (const value of junk) {
      await admin.set(key, value, { PX: 5000 });
      await expect(client.readExpiringVersion(key)).rejects.toMatchObject({ reason: 'CORRUPT' });
      // A later writer repairs it, so one bad value is not served for a whole TTL.
      expect(await client.setVersionBefore(key, 4, deadline)).toBe(true);
      expect((await client.readExpiringVersion(key))?.version).toBe(4);
      await admin.del(key);
    }
    expect(await client.readExpiringVersion(key)).toBeNull(); // absent
    await admin.set(key, `3:${(await client.serverTimeMs()) + 20}`, { PX: 20 });
    await wait(60);
    expect(await client.readExpiringVersion(key)).toBeNull(); // expired
  });

  it('keeps newer values when timed-out writes reach Valkey late', async () => {
    let holding = false;
    let received: (() => void) | undefined;
    let replied: (() => void) | undefined;
    const pending: Buffer[] = [];
    const sockets: Socket[] = [];
    let upstream: Socket | undefined;
    const flushHeld = () => {
      holding = false;
      if (!upstream) throw new Error('Proxy is not connected');
      for (const bytes of pending.splice(0)) upstream.write(bytes);
    };
    const server = createServer(downstream => {
      const connected = connect({ host: valkey.host, port: valkey.port });
      upstream = connected;
      sockets.push(downstream, connected);
      downstream.on('error', () => undefined);
      connected.on('error', () => undefined);
      connected.on('data', () => {
        replied?.();
        replied = undefined;
      });
      downstream.on('data', (data: Buffer) => {
        if (holding) {
          pending.push(data);
          received?.();
        } else connected.write(data);
      });
      connected.pipe(downstream);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy not listening');
    const slow = new RedisClient(
      { url: `redis://127.0.0.1:${address.port}`, commandTimeoutMs: 30 },
      new RedisMetrics(),
    );
    try {
      const readyBy = Date.now() + 5000;
      while (!slow.isReady && Date.now() < readyBy) await wait(10);
      if (!slow.isReady) throw new Error('Proxy connection not ready');
      const deadline = (await client.serverTimeMs()) + 5000;
      holding = true;
      const held = new Promise<void>(resolve => {
        received = resolve;
      });
      const timedOut = slow.setVersionBefore(key, 1, deadline).catch((error: unknown) => error);
      await withTimeout(held, 3000, 'Version command did not reach proxy');
      expect(await timedOut).toMatchObject({ reason: 'TIMEOUT' });
      expect(await client.setVersionBefore(key, 2, deadline)).toBe(true);
      const versionReply = new Promise<void>(resolve => {
        replied = resolve;
      });
      flushHeld();
      await withTimeout(versionReply, 3000, 'Delayed version command did not reach Valkey');
      expect((await client.readExpiringVersion(key))?.version).toBe(2);

      holding = true;
      const heldContent = new Promise<void>(resolve => {
        received = resolve;
      });
      const lateContent = slow
        .setIfAbsent('dbs110:immutable-test', 'stale', 60)
        .catch((error: unknown) => error);
      await withTimeout(heldContent, 3000, 'Content command did not reach proxy');
      expect(await lateContent).toMatchObject({ reason: 'TIMEOUT' });
      expect(await client.setIfAbsent('dbs110:immutable-test', 'current', 60)).toBe(true);
      const contentReply = new Promise<void>(resolve => {
        replied = resolve;
      });
      flushHeld();
      await withTimeout(contentReply, 3000, 'Delayed content command did not reach Valkey');
      expect(await client.get('dbs110:immutable-test')).toBe('current');

      // A command which reaches Valkey after its deadline must not publish at all.
      const expiresAt = (await client.serverTimeMs()) + 10;
      holding = true;
      const heldExpired = new Promise<void>(resolve => {
        received = resolve;
      });
      const expiredWrite = slow
        .setVersionBefore(key, 3, expiresAt)
        .catch((error: unknown) => error);
      await withTimeout(heldExpired, 3000, 'Expiring command did not reach proxy');
      expect(await expiredWrite).toMatchObject({ reason: 'TIMEOUT' });
      expect(await client.serverTimeMs()).toBeGreaterThan(expiresAt);
      const expiredReply = new Promise<void>(resolve => {
        replied = resolve;
      });
      flushHeld();
      await withTimeout(expiredReply, 3000, 'Expired command did not reach Valkey');
      expect((await client.readExpiringVersion(key))?.version).toBe(2);
    } finally {
      slow.onModuleDestroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);

  it.each([0, -1, 1.1, 2147483648, Number.NaN])('rejects invalid version %s', async value => {
    await expect(client.setVersionBefore(key, value, Date.now() + 1000)).rejects.toThrow(TypeError);
  });
});
