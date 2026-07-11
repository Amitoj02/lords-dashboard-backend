import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditAction } from './entities/audit-action.entity';
import { AuditLogEntry } from './entities/audit-log-entry.entity';
import { AuditInterceptor } from './interceptors/audit.interceptor';

/**
 * Append-only audit ledger. Declared @Global so any feature module can inject
 * AuditService to emit rows. Also registers the (opt-in) AuditInterceptor
 * globally — it only acts on routes annotated with @AuditEvent.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntry, AuditAction])],
  controllers: [AuditController],
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
