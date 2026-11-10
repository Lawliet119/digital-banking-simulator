import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { resolve } from 'node:path';
import { TLSSocket } from 'node:tls';
import { buildSslOptions } from '@database/pg-ssl';
import { AiGate } from './ai-gate';

const fixtures = resolve(__dirname, '../../../../test/support/tls-fixtures');

describe('RSK-02 pg gate verifies TLS with the database CA', () => {
  let server: Server;
  afterEach(async () => {
    // ES2022 lib does not expose Promise.withResolvers.
    if (server) await new Promise<void>(done => server.close(() => done()));
  });

  it.each(['ca.pem', 'other-ca.pem', undefined])('checks certificate with CA=%s', async ca => {
    const handshakes: boolean[] = [];
    server = createServer(socket => {
      socket.on('error', () => undefined);
      socket.once('data', () => {
        socket.write('S');
        const tls = new TLSSocket(socket, {
          isServer: true,
          key: readFileSync(resolve(fixtures, 'server.key')),
          cert:
            readFileSync(resolve(fixtures, 'server.pem'), 'utf8') +
            readFileSync(resolve(fixtures, 'ca.pem'), 'utf8'),
        });
        tls.on('secure', () => {
          handshakes.push(true);
          tls.destroy();
        });
        tls.on('error', () => {
          handshakes.push(false);
          tls.destroy();
        });
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const gate = new AiGate({
      connectionString: `postgres://synthetic:synthetic@127.0.0.1:${(server.address() as AddressInfo).port}/synthetic`,
      ssl: buildSslOptions({ enabled: true, caPath: ca ? resolve(fixtures, ca) : undefined }),
      policy: { revision: 'synthetic', dailyRequestLimit: 1, concurrentLimit: 1 },
      deadlineMs: 2000,
    });
    // Server speaks only SSLRequest/TLS, not SQL: gate must fail closed after the handshake.
    expect(await gate.tryAcquire()).toEqual({ kind: 'unavailable' });
    if (ca === 'ca.pem') expect(handshakes).toEqual([true]);
    else expect(handshakes).not.toContain(true);
  });

  it.each([
    'sslmode=no-verify',
    'sslmode=disable',
    'sslrootcert=ignored',
    'ssl=true',
    'uselibpqcompat=true',
  ])('rejects URL override %s before opening a socket', async parameter => {
    let connections = 0;
    server = createServer(socket => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const gate = new AiGate({
      connectionString: `postgres://synthetic:synthetic@127.0.0.1:${(server.address() as AddressInfo).port}/synthetic?${parameter}`,
      ssl: buildSslOptions({ enabled: true }),
      policy: { revision: 'synthetic', dailyRequestLimit: 1, concurrentLimit: 1 },
      deadlineMs: 100,
    });
    expect(await gate.tryAcquire()).toEqual({ kind: 'unavailable' });
    expect(connections).toBe(0);
  });
});
