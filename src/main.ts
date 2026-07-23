import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService<AppConfig, true>);
  const logger = new Logger('Bootstrap');

  // ── Fail closed on the mocks in production (LDA-C1) ─────────────────────────
  // The Discord OAuth mock is an authentication bypass (GET /api/auth/discord?as=
  // mints a real session JWT). It must NEVER run in production unless an operator
  // has explicitly opted in with ALLOW_MOCKS_IN_PROD=true. This is defence in
  // depth on top of the compose file's ${DISCORD_CLIENT_ID:?} guard and the
  // never-auto-enable-in-prod default in configuration.ts.
  const env = config.get('env', { infer: true });
  const discordCfg = config.get('discord', { infer: true });
  const allowMocksInProd = process.env.ALLOW_MOCKS_IN_PROD === 'true';
  if (env === 'production' && discordCfg.mock && !allowMocksInProd) {
    throw new Error(
      'Refusing to boot: the Discord OAuth mock is ACTIVE in production ' +
        '(DISCORD_MOCK=true). This is an authentication bypass. Unset DISCORD_MOCK ' +
        'and provide real DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET, or set ' +
        'ALLOW_MOCKS_IN_PROD=true to override (staging only).',
    );
  }
  // The BOT mock is not an auth bypass (it makes Discord side-effects no-ops), and
  // production legitimately runs it until the real bot is provisioned — warn, don't
  // refuse. Enabling the real bot flips DISCORD_BOT_MOCK=false and this goes quiet.
  if (env === 'production' && discordCfg.botMock) {
    logger.warn(
      'Discord BOT is MOCKED in production (DISCORD_BOT_MOCK=true): role sync and ' +
        'announcements are no-ops until a real DISCORD_BOT_TOKEN is provisioned.',
    );
  }

  const apiPrefix = config.get('apiPrefix', { infer: true });
  const port = config.get('port', { infer: true });
  const corsOrigins = config.get('corsOrigins', { infer: true });

  // Security headers + cookie parsing for the OAuth handoff.
  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.setGlobalPrefix(apiPrefix);

  // Validate and transform every incoming payload; strip unknown properties.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Let modules run onModuleDestroy/onApplicationShutdown on SIGTERM/SIGINT so
  // the in-process Discord gateway logs out cleanly and the sync worker stops.
  app.enableShutdownHooks();

  // OpenAPI / Swagger at /{apiPrefix}/docs.
  //
  // NOT mounted in production. The document enumerates every route, DTO shape and
  // validation rule in the API — a free reconnaissance map for anyone who finds
  // it, and there is no audience for it on a public deployment serving one
  // regiment. Set SWAGGER_ENABLED=true to force it on (e.g. a staging box).
  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' || config.get('env', { infer: true }) !== 'production';

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Lords Dashboard API')
      .setDescription('REST API for the Lords Regiment Dashboard (Holdfast: Nations at War)')
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(port);
  logger.log(`🚀 API running at http://localhost:${port}/${apiPrefix}`);
  logger.log(
    swaggerEnabled
      ? `📚 Swagger docs at http://localhost:${port}/${apiPrefix}/docs`
      : '📚 Swagger docs disabled (production; set SWAGGER_ENABLED=true to enable)',
  );
}

void bootstrap();
