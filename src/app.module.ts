import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // Global, validated configuration available everywhere via ConfigService.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    // Basic rate limiting: 120 requests / minute / IP by default.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    DatabaseModule,
    HealthModule,
    AuthModule,

    // ── Feature modules (added as the schema is implemented) ─────────────
    // MembersModule,
    // RanksModule,
    // MedalsModule,
    // EventsModule,
    // GalleryModule,
    // ApplicationsModule,
    // AuditModule,
    // SettingsModule,
  ],
  providers: [
    // Throttle every route globally; individual routes can override with @Throttle/@SkipThrottle.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
