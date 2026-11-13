import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { databaseConfig } from '@config/database.config';
import { TransactionService } from '@database/transaction.service';
import { AuditHttpModule } from './audit-http.module';
import { AuditController } from './audit.controller';
import { AuditSearchService } from './audit-search.service';
import { AuditModule } from './audit.module';
import { RoleDenialAudit } from '@modules/identity';
import { AuditService } from './audit.service';

// This unit test proves wiring only; the HTTP/PG suite executes these real providers against PG.
@Global()
@Module({
  providers: [
    TransactionService,
    { provide: getDataSourceToken(), useValue: {} },
    {
      provide: databaseConfig.KEY,
      useValue: {
        url: 'postgres://unused:unused@127.0.0.1:1/unused',
        poolMax: 12,
        ssl: false,
        sslCaPath: undefined,
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
        idleInTransactionTimeoutMs: 10000,
      },
    },
  ],
  exports: [TransactionService],
})
class GlobalDatabaseFixture {}

describe('AuditHttpModule (DBS-103)', () => {
  it('TC-103-19 resolves the HTTP service and writer through their real DI boundaries', async () => {
    const context = await Test.createTestingModule({
      imports: [GlobalDatabaseFixture, AuditHttpModule],
    }).compile();
    try {
      expect(context.get(AuditController)).toBeInstanceOf(AuditController);
      expect(context.get(AuditSearchService)).toBeInstanceOf(AuditSearchService);
      expect(context.get(AuditService)).toBeInstanceOf(AuditService);
    } finally {
      await context.close();
    }
  });

  it('TC-103-19 keeps query/controller/identity out of the shared writer module', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AuditModule) ?? []).toEqual([]);
    // BL-132: the only addition is the RoleDenialAudit port, an alias of AuditService; no query
    // service, no controller, no IdentityService/IdentityModule.
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuditModule)).toEqual([
      AuditService,
      { provide: RoleDenialAudit, useExisting: AuditService },
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AuditModule) ?? []).toEqual([]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AuditHttpModule)).toEqual([AuditModule]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AuditHttpModule) ?? []).toEqual([]);
  });
});
