import { createServer, connect, type Socket } from 'node:net';

/** Test-only response delay. FIFO flushing preserves RESP order during recovery. */
export async function startLatencyProxy(host: string, port: number) {
  let delay = 0;
  let requestBytes = 0;
  let stopped = false;
  type Peer = {
    down: Socket;
    up: Socket;
    pending: { data: Buffer; due: number }[];
    timer?: NodeJS.Timeout;
  };
  const peers = new Set<Peer>();
  const flush = (peer: Peer, force = false) => {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = undefined;
    while (peer.pending.length && (force || peer.pending[0].due <= Date.now())) {
      const next = peer.pending.shift()!;
      if (!peer.down.destroyed) peer.down.write(next.data);
    }
    if (peer.pending.length && !peer.down.destroyed)
      peer.timer = setTimeout(() => flush(peer), Math.max(1, peer.pending[0].due - Date.now()));
  };
  const server = createServer(down => {
    const up = connect({ host, port });
    const peer: Peer = {
      down,
      up,
      pending: [],
      timer: undefined as NodeJS.Timeout | undefined,
    };
    peers.add(peer);
    down.on('data', chunk => {
      requestBytes += chunk.length;
      up.write(chunk);
    });
    up.on('data', (chunk: Buffer) => {
      peer.pending.push({ data: chunk, due: Date.now() + delay });
      if (delay === 0) flush(peer, true);
      else if (!peer.timer) peer.timer = setTimeout(() => flush(peer), delay);
    });
    const cleanup = () => {
      if (peer.timer) clearTimeout(peer.timer);
      peer.pending = [];
      peers.delete(peer);
      down.destroy();
      up.destroy();
    };
    down.on('error', cleanup);
    up.on('error', cleanup);
    down.on('close', cleanup);
    up.on('close', cleanup);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy address unavailable');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    get requestBytes() {
      return requestBytes;
    },
    setDelay(ms: number) {
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 10000)
        throw new TypeError('Invalid proxy delay');
      delay = ms;
      if (ms === 0) for (const p of peers) flush(p, true);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const p of [...peers]) {
        if (p.timer) clearTimeout(p.timer);
        p.down.destroy();
        p.up.destroy();
      }
      peers.clear();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}
