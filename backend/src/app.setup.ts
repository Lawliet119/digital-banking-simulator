import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { installBigIntJson } from '@common/money';
import { enrichOpenApi } from '@common/openapi/enrich-openapi';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import {
  CORRELATION_ID_HEADER,
  correlationIdMiddleware,
  REQUEST_ID_HEADER,
} from './common/middleware/correlation-id.middleware';

/**
 * The ALB closes a connection that has been idle for this long (the default; nothing in Terraform
 * changes it). The side that closes first must be the ALB: when Node closes first, the ALB can
 * send a request down a connection Node has just closed and answer 502 itself (BL-414: 1 in
 * 172,805 requests of the DBS-166 `baseline`, none counted as a 5xx by the application).
 */
export const ALB_IDLE_TIMEOUT_MS = 60_000;
/** Node's default is 5 s, far below the ALB's idle timeout; keep idle connections longer than it. */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = ALB_IDLE_TIMEOUT_MS + 5_000;
/** Node requires `headersTimeout` above `keepAliveTimeout`, or the header timer closes the socket first. */
export const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEP_ALIVE_TIMEOUT_MS + 1_000;

export interface HttpSettings {
  /** Number of reverse proxies in front (the ALB). 0 = none. */
  trustProxyHops: number;
  /** Allowed browser origins. Empty = no cross-origin access in production. */
  corsOrigins: string[];
  isProduction: boolean;
}

/**
 * Everything that shapes HTTP behaviour, in one place so `main.ts` and the e2e tests run the SAME
 * wiring: correlation id, security headers, CORS, versioning, error format, validation.
 */
export function configureHttpApp(
  app: NestExpressApplication,
  settings: HttpSettings,
  requestLogger?: RequestHandler,
  requestMetrics?: RequestHandler,
): void {
  // A bigint left in a response body becomes a string instead of a 500. main.ts also installs it
  // for the worker, which has no HTTP; calling it again changes nothing, and having it here means
  // the e2e tests, which use this function and not main.ts, exercise the same behaviour.
  installBigIntJson();

  // BL-414: set before anything listens, so no connection is accepted with Node's 5 s default.
  const server = app.getHttpServer();
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;

  // Behind the ALB, req.ip must be the client, not the load balancer (per-IP rate limiting).
  if (settings.trustProxyHops > 0) {
    app.set('trust proxy', settings.trustProxyHops);
  }

  app.use(correlationIdMiddleware);
  // Right after the correlation id and before everything else, so the time of a request covers
  // CORS, body parsing, guards and the handler (DBS-144).
  if (requestMetrics) app.use(requestMetrics);
  if (requestLogger) app.use(requestLogger);
  app.use(helmet());
  app.use(compression());
  app.enableCors({
    // Production allows only the configured origins; an empty list means "no cross-origin".
    origin: settings.corsOrigins.length > 0 ? settings.corsOrigins : !settings.isProduction,
    credentials: true,
    exposedHeaders: [CORRELATION_ID_HEADER, REQUEST_ID_HEADER, 'Retry-After'],
  });

  // URI versioning: every route is /v1/… unless it opts out (health probes).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

/** Swagger UI at /docs. Not mounted in production. */
export function setupSwagger(app: INestApplication): void {
  const document = enrichOpenApi(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Digital Banking Simulator API')
        .setDescription('Educational simulation — no real money moves.')
        .setVersion('1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build(),
    ),
  );
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      // DBS-137: show x-roles and x-error-codes in the UI.
      showExtensions: true,
    },
  });
}
