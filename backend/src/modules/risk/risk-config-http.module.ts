import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { RiskConfigHttpController } from './risk-config-http.controller';
import { RiskConfigHttpService } from './risk-config-http.service';

@Module({
  imports: [AuditModule],
  controllers: [RiskConfigHttpController],
  providers: [RiskConfigHttpService],
})
export class RiskConfigHttpModule {}
