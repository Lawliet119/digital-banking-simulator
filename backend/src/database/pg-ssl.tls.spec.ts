import { readFileSync } from 'node:fs';
import { createServer, Server, Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { TLSSocket } from 'node:tls';
import { DataSource } from 'typeorm';
import { buildSslOptions } from './pg-ssl';

const fixtures = resolve(__dirname, '../../test/support/tls-fixtures');
const caPath = resolve(fixtures, 'ca.pem');
const otherCaPath = resolve(fixtures, 'other-ca.pem');
const REJECTIONS = [
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
];

/**
 * A server that speaks only the start of the PostgreSQL protocol: it answers the SSLRequest with
 * `S`, then performs a real TLS handshake with a certificate signed by the test CA. It never
 * speaks SQL, so a connection that gets past the handshake ends in a closed socket.
 */
function fakePostgres(chain: 'leaf' | 'with-root') {
  const handshakes: boolean[] = [];
  const server: Server = createServer((socket: Socket) => {
    socket.once('data', () => {
      socket.write('S');
      const cert =
        chain === 'with-root'
          ? readFileSync(resolve(fixtures, 'server.pem'), 'utf8') + readFileSync(caPath, 'utf8')
          : readFileSync(resolve(fixtures, 'server.pem'));
      const tls = new TLSSocket(socket, {
        isServer: true,
        key: readFileSync(resolve(fixtures, 'server.key')),
        cert,
      });
      tls.on('secure', () => {
        handshakes.push(true);
        tls.destroy();
      });
      tls.on('error', () => handshakes.push(false));
    });
    socket.on('error', () => undefined);
  });
  return { server, handshakes };
}

async function connect(
  server: Server,
  ssl: ReturnType<typeof buildSslOptions>,
): Promise<NodeJS.ErrnoException | undefined> {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const dataSource = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port,
    username: 'u',
    database: 'd',
    ssl,
    connectTimeoutMS: 5000,
    // the app never retries a refused certificate; keep the test fast
    extra: { connectionTimeoutMillis: 5000 },
  });
  try {
    await dataSource.initialize();
  } catch (error) {
    return error as NodeJS.ErrnoException;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
  return undefined;
}

describe('TC-67-07 TLS verification of the database server certificate', () => {
  let current: Server | undefined;
  afterEach(async () => {
    await new Promise<void>(done => (current ? current.close(() => done()) : done()));
    current = undefined;
  });

  it.each(['leaf', 'with-root'] as const)(
    'accepts a certificate signed by the CA given in the CA path (server sends %s)',
    async chain => {
      const { server, handshakes } = fakePostgres(chain);
      current = server;
      const error = await connect(server, buildSslOptions({ enabled: true, caPath }));
      expect(handshakes).toEqual([true]);
      expect(REJECTIONS).not.toContain(error?.code);
    },
  );

  it.each(['leaf', 'with-root'] as const)(
    'rejects it with a different CA (server sends %s)',
    async chain => {
      const { server, handshakes } = fakePostgres(chain);
      current = server;
      const error = await connect(server, buildSslOptions({ enabled: true, caPath: otherCaPath }));
      expect(REJECTIONS).toContain(error?.code);
      expect(handshakes).not.toContain(true);
    },
  );

  it('rejects it when no CA is given (Node does not trust the test CA by default)', async () => {
    const { server, handshakes } = fakePostgres('with-root');
    current = server;
    const error = await connect(server, buildSslOptions({ enabled: true }));
    expect(REJECTIONS).toContain(error?.code);
    expect(handshakes).not.toContain(true);
  });
});
