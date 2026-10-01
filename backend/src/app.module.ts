import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { modulesForRole } from './modules';

/**
 * Root module. Cross-cutting infrastructure is always loaded; business modules are chosen by
 * `APP_ROLE` in `modules/index.ts`.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, ...modulesForRole()],
})
export class AppModule {}
