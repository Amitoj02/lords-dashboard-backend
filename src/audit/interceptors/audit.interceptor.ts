import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.interface';
import { AuditService } from '../audit.service';
import { AUDIT_EVENT_KEY, AuditEventMeta } from '../decorators/audit-event.decorator';

/** Pull a stringified `id` off a handler result, if present. */
const extractId = (result: unknown): string | null =>
  result && typeof result === 'object' && 'id' in result ? String(result.id) : null;

/**
 * Records an audit row for routes annotated with @AuditEvent, after the handler
 * resolves successfully. Registered globally; a no-op when no metadata is set.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditEventMeta | undefined>(AUDIT_EVENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;

    return next.handle().pipe(
      tap((result) => {
        if (!user) return;
        void this.audit.record({
          regimentId: user.regimentId,
          action: meta.action,
          severity: meta.severity,
          actor: AuditService.actorFromUser(user, request.ip ?? null),
          target: { type: meta.targetType ?? null, id: extractId(result) },
        });
      }),
    );
  }
}
