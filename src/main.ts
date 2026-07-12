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

  // OpenAPI / Swagger at /{apiPrefix}/docs
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

  await app.listen(port);
  logger.log(`🚀 API running at http://localhost:${port}/${apiPrefix}`);
  logger.log(`📚 Swagger docs at http://localhost:${port}/${apiPrefix}/docs`);
}

void bootstrap();
