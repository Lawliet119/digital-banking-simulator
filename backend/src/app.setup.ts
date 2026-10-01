import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import {
  CORRELATION_ID_HEADER,
  correlationIdMiddleware,
} from './common/middleware/correlation-id.middleware';

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
export function configureHttpApp(app: NestExpressApplication, settings: HttpSettings): void {
  // Behind the ALB, req.ip must be the client, not the load balancer (per-IP rate limiting).
  if (settings.trustProxyHops > 0) {
    app.set('trust proxy', settings.trustProxyHops);
  }

  app.use(correlationIdMiddleware);
  app.use(helmet());
  app.use(compression());
  app.enableCors({
    // Production allows only the configured origins; an empty list means "no cross-origin".
    origin: settings.corsOrigins.length > 0 ? settings.corsOrigins : !settings.isProduction,
    credentials: true,
    exposedHeaders: [CORRELATION_ID_HEADER, 'Retry-After'],
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
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Digital Banking Simulator API')
      .setDescription('Educational simulation — no real money moves.')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .build(),
  );
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });
}
