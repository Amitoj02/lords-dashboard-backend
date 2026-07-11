import { SetMetadata } from '@nestjs/common';
import { AuditSeverity } from '../../common/enums';

export const AUDIT_EVENT_KEY = 'audit_event';

export interface AuditEventMeta {
  action: string;
  severity?: AuditSeverity;
  targetType?: string;
}

/**
 * Declaratively audit a successful mutation via the AuditInterceptor. Use for
 * simple cases that need only actor + action + target id; for rows that need
 * before/after snapshots or a computed target, call AuditService.record()
 * directly from the service instead.
 *
 *   @AuditEvent('settings.update', { targetType: 'regiment' })
 *   @Patch('settings') update() { ... }
 */
export const AuditEvent = (action: string, options: Omit<AuditEventMeta, 'action'> = {}) =>
  SetMetadata(AUDIT_EVENT_KEY, { action, ...options } satisfies AuditEventMeta);
