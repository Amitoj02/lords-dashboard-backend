import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../types/authenticated-user.interface';

/**
 * Injects the authenticated user (or a single field of it) from request.user.
 *   @CurrentUser() user: AuthenticatedUser
 *   @CurrentUser('memberId') memberId: string | null
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;
    return data ? user?.[data] : user;
  },
);
