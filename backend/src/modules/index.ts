import type { DynamicModule, Type } from '@nestjs/common';
import { AppRole, runsHttp, runsWorkers } from '@common/app-role/app-role';
import { HealthModule } from './health';
import { IdentityModule } from './identity';
import { AccountsModule } from './accounts';

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
  // LedgerModule, AuditModule, RiskModule — added by their owners.
  // A module that other modules only import (AccountsModule is imported by LedgerModule) does not
  // need to be listed for each role: Nest resolves it through the importer. AccountsModule sits in
  // apiModules so an `api` instance fails at boot if its providers ever stop resolving.
];

const apiModules: ModuleRef[] = [HealthModule, IdentityModule, AccountsModule];

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
