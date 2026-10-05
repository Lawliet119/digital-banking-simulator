import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { databaseConfig } from '../config/database.config';
import { type TransactionOptions, withTransaction } from './transaction.helper';

/**
 * Injectable wrapper around `withTransaction`, so services never manage query runners themselves.
 *
 *   await this.tx.run(async manager => {
 *     await this.accounts.lockForUpdate(ids, manager);
 *     …
 *   });
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(databaseConfig.KEY) private readonly config: ConfigType<typeof databaseConfig>,
  ) {}

  run<T>(fn: (manager: EntityManager) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return withTransaction(this.dataSource, fn, {
      lockTimeoutMs: this.config.lockTimeoutMs,
      statementTimeoutMs: this.config.statementTimeoutMs,
      idleInTransactionTimeoutMs: this.config.idleInTransactionTimeoutMs,
      onRetry: ({ attempt, error }) => {
        this.logger.warn(
          `Transaction retry #${attempt}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      ...options,
    });
  }
}
