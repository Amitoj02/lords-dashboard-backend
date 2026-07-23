import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_GATED_KEY = 'allowWhenGated';

/**
 * Marks an authenticated route as reachable even when the guild gate would deny
 * the caller (LDA-M5). Apply to the endpoints a gated user needs in order to SEE
 * the gate and escape it — /auth/me (render the gate), /auth/guild-status
 * (re-check membership), and /auth/logout — otherwise the gate would trap them
 * with no way to recover.
 */
export const AllowWhenGated = () => SetMetadata(ALLOW_WHEN_GATED_KEY, true);
