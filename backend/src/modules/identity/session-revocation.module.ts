import { Global, Module } from '@nestjs/common';
import { RedisModule } from '@libs/redis';
import { SessionRevocationCache } from './session-revocation-cache';

/** One cache provider for the guard and account locks; SQL-only contexts need no Redis socket. */
@Global()
@Module({
  imports: [RedisModule],
  providers: [SessionRevocationCache],
  exports: [SessionRevocationCache],
})
export class SessionRevocationModule {}
