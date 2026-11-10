import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { FraudHttpController } from './fraud-http.controller';
import { FraudHttpService } from './fraud-http.service';

@Module({
  imports: [AuditModule],
  controllers: [FraudHttpController],
  providers: [FraudHttpService],
})
export class FraudHttpModule {}
