import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { authConfig } from '@config/auth.config';
import { activeTransactionContext } from '@database/transaction.helper';
import { RedisClient } from '@libs/redis';
import { safeErrorMetadata } from '@common/logging/logging.options';

/** Positive, committed revocation marks only. A cache hit is never proof of permission. */
@Injectable()
export class SessionRevocationCache {
  private readonly logger = new Logger(SessionRevocationCache.name);
  constructor(
    private readonly redis: RedisClient,
    @Inject(authConfig.KEY) private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  async read(userId: string): Promise<Date | undefined> {
    try {
      const value = await this.redis.get(`revoked_at:${userId}`);
      if (value === null || !/^[1-9]\d{0,11}$/.test(value)) return undefined;
      const seconds = Number(value);
      if (!Number.isSafeInteger(seconds) || seconds > 253_402_300_799) return undefined;
      return new Date(seconds * 1000);
    } catch {
      // RedisClient records operational fallback metrics; SQL remains authoritative.
      return undefined;
    }
  }

  async publish(userId: string, revokedAt: Date): Promise<void> {
    if (activeTransactionContext.getStore()) {
      throw new TypeError('Publish a revocation cache marker outside the database transaction');
    }
    const seconds = Math.floor(revokedAt.getTime() / 1000);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253_402_300_799) return;
    try {
      await this.redis.set(
        `revoked_at:${userId}`,
        String(seconds),
        this.auth.accessTokenTtlSeconds,
      );
    } catch (error) {
      // COMMIT already succeeded. A failed cache write cannot undo it or admit the old token.
      this.logger.warn(safeErrorMetadata(error), 'Session revocation cache unavailable');
    }
  }
}
