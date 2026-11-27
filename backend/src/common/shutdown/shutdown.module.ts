import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { InflightRequests, InflightRequestsInterceptor } from './inflight-requests';

/** Counts running HTTP handlers for `enableGracefulShutdown`; imported only when serving HTTP. */
@Module({
  providers: [
    InflightRequests,
    { provide: APP_INTERCEPTOR, useClass: InflightRequestsInterceptor },
  ],
  exports: [InflightRequests],
})
export class ShutdownModule {}
