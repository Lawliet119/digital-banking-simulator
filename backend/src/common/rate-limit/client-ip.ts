import type { Request } from 'express';

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * The address a request is counted against. `request.ip` is already what Express worked out from
 * `X-Forwarded-For` for the configured `TRUST_PROXY_HOPS` (0 = ignore the header, 1 = behind the
 * ALB); this only removes the IPv4-mapped prefix so one client has one key. Never `undefined`:
 * an unknown address is one shared key, which is stricter, not looser.
 */
export function clientIp(request: Pick<Request, 'ip' | 'socket'>): string {
  const raw = request.ip || request.socket?.remoteAddress || '';
  if (!raw) return 'unknown';
  const mapped = MAPPED_V4.exec(raw);
  return mapped ? mapped[1] : raw;
}
