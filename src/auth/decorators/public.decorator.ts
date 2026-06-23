import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as publicly accessible, bypassing the globally-registered
 * JwtAuthGuard. Apply to login, OAuth callbacks, health checks and any other
 * unauthenticated endpoint.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
