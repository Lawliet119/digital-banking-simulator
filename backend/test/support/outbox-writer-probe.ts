import { Body, Controller, Injectable, Module, Post, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { configureHttpApp } from '../../src/app.setup';
import { ConfigModule } from '../../src/config/config.module';
import { appConfig } from '@config/app.config';
import { DatabaseModule } from '@database/database.module';
import { TransactionService } from '@database/transaction.service';
import { LoggingModule } from '@common/logging/logging.module';
import { createHttpLogging } from '@common/logging/http-logging';
import type { RequestWithCorrelationId } from '@common/middleware/correlation-id.middleware';
import { OutboxModule, OutboxWriter } from '@modules/outbox';
import { TRANSFER_SAMPLE } from './event-samples';

/** Test orchestration only: every HTTP producer reaches this barrier before starting its work. */
@Injectable()
export class ProbeGate {
  private remaining = 0;
  private ready = Promise.resolve();
  private release: () => void = () => undefined;
  private fail: (error: Error) => void = () => undefined;
  private timer?: NodeJS.Timeout;

  arm(parties: number): void {
    this.onModuleDestroy();
    this.remaining = parties;
    this.ready = new Promise((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
    // A deadline bounds a missing request too; observing it here avoids an unhandled rejection
    // when an armed fixture fails before any request has reached arrive().
    void this.ready.catch(() => undefined);
    this.timer = setTimeout(() => {
      this.remaining = 0;
      this.fail(new Error('Probe barrier deadline exceeded'));
    }, 5000);
  }

  async arrive(): Promise<void> {
    const ready = this.ready;
    if (this.remaining > 0) {
      this.remaining--;
      if (this.remaining === 0) {
        clearTimeout(this.timer);
        this.release();
      }
    }
    await ready;
  }

  onModuleDestroy(): void {
    clearTimeout(this.timer);
    if (this.remaining > 0) this.fail(new Error('Probe barrier closed'));
    this.remaining = 0;
  }
}

@Controller('outbox-probe')
class OutboxProbeController {
  constructor(
    private readonly writer: OutboxWriter,
    private readonly tx: TransactionService,
    private readonly gate: ProbeGate,
  ) {}

  @Post('events')
  async create(@Req() request: RequestWithCorrelationId, @Body() body: { eventId?: string }) {
    await this.gate.arrive();
    const event = {
      ...TRANSFER_SAMPLE,
      eventId: body.eventId ?? randomUUID(),
      correlationId: request.correlationId!,
    };
    await this.tx.run(manager => this.writer.add(manager, event));
    return { eventId: event.eventId, correlationId: event.correlationId };
  }
}

@Module({
  imports: [ConfigModule, LoggingModule, DatabaseModule, OutboxModule],
  controllers: [OutboxProbeController],
  providers: [ProbeGate],
})
class OutboxProbeModule {}

/** A real Nest/PG fixture, never a replacement business service or production HTTP route. */
export async function createOutboxProbe(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [OutboxProbeModule] }).compile();
  let app: NestExpressApplication | undefined;
  try {
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    const config = app.get<ReturnType<typeof appConfig>>(appConfig.KEY);
    configureHttpApp(app, config, createHttpLogging(await app.resolve(PinoLogger), config));
    await app.init();
    return app;
  } catch (error) {
    try {
      if (app) await app.close();
      else await moduleRef.close();
    } catch {
      // Preserve the initialization failure; the driver also tears down its isolated database.
    }
    throw error;
  }
}
