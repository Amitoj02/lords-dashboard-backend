import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApplicationsModule } from './applications/applications.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthzModule } from './authz/authz.module';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MedalsModule } from './medals/medals.module';
import { MembersModule } from './members/members.module';
import { RanksModule } from './ranks/ranks.module';
import { RegimentsModule } from './regiments/regiments.module';

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

    // ── Cross-cutting infrastructure (global) ────────────────────────────
    AuthzModule,
    AuditModule,

    // ── Feature modules (added as the schema is implemented) ─────────────
    MembersModule,
    ApplicationsModule,
    RanksModule,
    MedalsModule,
    RegimentsModule,
    // EventsModule,
    // GalleryModule,
    // SettingsModule,
  ],
  providers: [
    // Throttle every route globally; individual routes can override with @Throttle/@SkipThrottle.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
