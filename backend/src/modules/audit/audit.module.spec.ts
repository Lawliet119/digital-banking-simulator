import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import type { databaseConfig } from '@config/database.config';
import { databaseConfig as databaseConfigToken } from '@config/database.config';
import { TransactionService } from '@database/transaction.service';
import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';

const CONFIG: ConfigType<typeof databaseConfig> = {
  url: 'postgres://u:p@localhost:5432/banking',
  poolMax: 10,
  ssl: false,
  sslCaPath: undefined,
  lockTimeoutMs: 1500,
  statementTimeoutMs: 4000,
  idleInTransactionTimeoutMs: 7000,
};

// Stands in for the real `DatabaseModule`, which is `@Global()` too — AuditModule imports neither
// it nor this, exactly as it should, and still resolves TransactionService through the global scope.
@Global()
@Module({
  providers: [
    TransactionService,
    { provide: getDataSourceToken(), useValue: {} },
    { provide: databaseConfigToken.KEY, useValue: CONFIG },
  ],
  exports: [TransactionService],
})
class FakeGlobalDatabaseModule {}

describe('AuditModule (DBS-56)', () => {
  it('TC-56-12 resolves AuditService through real Nest DI, backed by the real TransactionService', async () => {
    // DataSource is a dumb value here: TransactionService is never asked to .run() anything in
    // this test, so no real Postgres connection is needed. What this proves is that AuditModule's
    // own providers/exports wire up, and that AuditService's dependency on the REAL
    // TransactionService class resolves via the global scope — not a stub standing in for the
    // whole DI graph, and not an explicit import AuditModule should not need.
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalDatabaseModule, AuditModule],
    }).compile();

    expect(moduleRef.get(AuditService)).toBeInstanceOf(AuditService);
  });
});
