import { Module } from '@nestjs/common';
import { AccountsModule } from '@modules/accounts';
import { AuditModule } from '@modules/audit';
import { FraudHttpController } from './fraud-http.controller';
import { FraudHttpService } from './fraud-http.service';

@Module({
  imports: [AccountsModule, AuditModule],
  controllers: [FraudHttpController],
  providers: [FraudHttpService],
})
export class FraudHttpModule {}
