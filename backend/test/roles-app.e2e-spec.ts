import type { INestApplication } from '@nestjs/common';
import {
  ApplicationConfig,
  DiscoveryService,
  MetadataScanner,
  ModulesContainer,
  NestFactory,
  Reflector,
} from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import request from 'supertest';
import { NO_ROLE_ALLOWLIST } from './support/no-role-allowlist';

/**
 * Boots the REAL `AppModule` (role `api`, real PostgreSQL from docker compose), like
 * app-guard.e2e-spec.ts: every other role test builds its own small module, so none of them
 * proves that RolesGuard is registered in app.module.ts, or that a route a developer adds later
 * has declared its roles. `process.env` is set before the dynamic import because
 * `modules/index.ts` reads APP_ROLE the moment `app.module.ts` is evaluated.
 */

type AnyFn = (...args: never[]) => unknown;

interface Route {
  label: string;
  handler: AnyFn;
  controller: AnyFn;
}

describe('RolesGuard in the real AppModule (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const original = process.env;

  // Loaded after process.env is set, so they see the same module state as the app does.
  let ROLES_KEY: string;
  let IS_PUBLIC_KEY: string;
  let JwtAuthGuard: new (...args: never[]) => object;
  let RolesGuard: new (...args: never[]) => object;

  beforeAll(async () => {
    process.env = {
      ...original,
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      DATABASE_URL:
        original.DATABASE_URL ?? 'postgres://banking:banking_local_only@localhost:5432/banking',
      REDIS_URL: original.REDIS_URL ?? 'redis://localhost:6379',
    };

    const { AppModule } = await import('../src/app.module');
    const { configureHttpApp } = await import('../src/app.setup');
    const identity = await import('../src/modules/identity');
    ({ ROLES_KEY, JwtAuthGuard, RolesGuard } = identity as unknown as {
      ROLES_KEY: string;
      JwtAuthGuard: new (...args: never[]) => object;
      RolesGuard: new (...args: never[]) => object;
    });
    ({ IS_PUBLIC_KEY } = await import('../src/common/auth/public.decorator'));

    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: ['error', 'warn'],
    });
    configureHttpApp(app as NestExpressApplication, {
      trustProxyHops: 0,
      corsOrigins: [],
      isProduction: false,
    });
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
    process.env = original;
  });

  it('TC-51-14 boots with RolesGuard resolved, and registers JwtAuthGuard first and RolesGuard second', () => {
    const globalGuards = app
      .get(ApplicationConfig)
      .getGlobalGuards()
      .map(guard => guard.constructor.name);

    // The guard order is the contract; TC-51-19 proves it by behaviour, this proves it is wired.
    // DBS-89 adds the per-customer transfer limit AFTER the two: it needs `request.user`. The
    // per-IP limit is a middleware, so it is not among the guards.
    expect(globalGuards).toEqual([JwtAuthGuard.name, RolesGuard.name, 'TransferRateLimitGuard']);
  });

  it('TC-51-14 a protected route with no token is still 401 UNAUTHENTICATED (not 403)', async () => {
    const res = await request(server).get('/v1/identity/me').expect(401);

    expect(res.body.errorCode).toBe('UNAUTHENTICATED');
  });

  /** Every route of every controller of the app, with the handler and its controller class. */
  function allRoutes(): Route[] {
    // AppModule does not import DiscoveryModule (and must not just for a test), so build the
    // service from the ModulesContainer every app has.
    const discovery = new DiscoveryService(app.get(ModulesContainer));
    const scanner = new MetadataScanner();
    const routes: Route[] = [];

    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      const controller = wrapper.metatype as AnyFn | null;
      if (!instance || !controller) continue;
      const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';

      for (const name of scanner.getAllMethodNames(Object.getPrototypeOf(instance) as object)) {
        const handler = instance[name] as AnyFn;
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (verb === undefined) continue;
        const path = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
        const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'][verb];
        const version = base === 'health' ? '' : '/v1';
        routes.push({
          label: `${method} ${version}/${[base, path].filter(Boolean).join('/')}`,
          handler,
          controller,
        });
      }
    }
    return routes;
  }

  const reflector = new Reflector();
  const hasRoles = (route: Route): boolean =>
    reflector.getAllAndOverride<unknown>(ROLES_KEY, [route.handler, route.controller]) !==
    undefined;
  const isPublic = (route: Route): boolean =>
    reflector.getAllAndOverride<unknown>(IS_PUBLIC_KEY, [route.handler, route.controller]) === true;
  /** Routes that declare neither @Public() nor @Roles(): the ones that fall back to "any valid token". */
  const undeclaredRoutes = (): string[] =>
    allRoutes()
      .filter(route => !hasRoles(route) && !isPublic(route))
      .map(route => route.label)
      .sort();

  it('TC-51-27 every route of the real app is @Public, has @Roles, or is on the written allowlist', () => {
    expect(allRoutes().length).toBeGreaterThan(0);

    expect(undeclaredRoutes()).toEqual(Object.keys(NO_ROLE_ALLOWLIST).sort());
  });

  it('TC-51-27 no route combines @Public with @Roles (it could never be reached by a caller)', () => {
    const both = allRoutes()
      .filter(route => hasRoles(route) && isPublic(route))
      .map(route => route.label);

    expect(both).toEqual([]);
  });

  describe('TC-51-27 mutation proof: the check goes red when a route loses its declaration', () => {
    const health = (): Route => {
      const route = allRoutes().find(r => r.label === 'GET /health/live');
      if (!route) throw new Error('GET /health/live is not in the app');
      return route;
    };

    it('@Public() is declared on the HealthController class, so it is removed from the class', () => {
      const route = health();
      const before = Reflect.getMetadata(IS_PUBLIC_KEY, route.controller) as unknown;
      expect(before).toBe(true);
      try {
        // Deleting it on the handler would change nothing: the class value would still apply.
        Reflect.deleteMetadata(IS_PUBLIC_KEY, route.controller);

        expect(undeclaredRoutes()).toContain('GET /health/live');
      } finally {
        Reflect.defineMetadata(IS_PUBLIC_KEY, before, route.controller);
      }
    });

    it('an explicit false on the handler overrides the class-level @Public()', () => {
      const route = health();
      try {
        Reflect.defineMetadata(IS_PUBLIC_KEY, false, route.handler);

        expect(undeclaredRoutes()).toContain('GET /health/live');
      } finally {
        Reflect.deleteMetadata(IS_PUBLIC_KEY, route.handler);
      }
    });

    it('after both restores the real state is clean again', () => {
      expect(undeclaredRoutes()).toEqual(Object.keys(NO_ROLE_ALLOWLIST).sort());
    });
  });
});
