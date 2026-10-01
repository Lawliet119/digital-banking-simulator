import type { DynamicModule, Type } from '@nestjs/common';
import { AppRole, runsHttp, runsWorkers } from '@common/app-role/app-role';
import { HealthModule } from './health';

type ModuleRef = Type<unknown> | DynamicModule;

/**
 * Where each module is registered. This file is the single place that decides which role loads
 * what; see README.md in this folder for the rules.
 *
 * Add a module to `apiModules` when it only serves HTTP (controllers), to `workerModules` when it
 * only runs consumers/schedulers, and to `sharedModules` when it has both. A shared module that
 * starts a consumer must guard it with `runsWorkers()` so an `api` instance never polls a queue.
 */
const sharedModules: ModuleRef[] = [
  // IdentityModule, AccountsModule, LedgerModule, AuditModule, RiskModule — added by their owners.
];

const apiModules: ModuleRef[] = [HealthModule];

const workerModules: ModuleRef[] = [
  // OutboxModule (relay), NotificationModule — added by #3.
];

/** The module list for the given role (defaults to the current process's `APP_ROLE`). */
export function modulesForRole(role?: AppRole): ModuleRef[] {
  return [
    ...sharedModules,
    ...(runsHttp(role) ? apiModules : []),
    ...(runsWorkers(role) ? workerModules : []),
  ];
}
