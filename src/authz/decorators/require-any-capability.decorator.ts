import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { Capability } from '../../common/enums';
import { ANY_CAPABILITY_KEY, AnyCapabilityGuard } from '../guards/any-capability.guard';

/**
 * Gate a route on ANY ONE of several capabilities (logical OR) — the
 * counterpart of `@RequireCapability(...)`, which requires all of them (AND):
 *
 *   @RequireAnyCapability(Capability.EditRanksMedals, Capability.ManageEvents)
 *   @Get('roles')
 *   listRoles() { ... }
 *
 * Reach for it when one READ serves more than one screen. Gating such a route
 * on a single capability locks out a role that legitimately arrives from the
 * other direction, and adding the second capability to the AND guard would
 * demand both — locking out even more people. Anything that MUTATES should
 * still name the one capability that owns it.
 */
export const RequireAnyCapability = (...capabilities: Capability[]) =>
  applyDecorators(
    SetMetadata(ANY_CAPABILITY_KEY, capabilities),
    UseGuards(AnyCapabilityGuard),
    ApiForbiddenResponse({ description: `Requires one of: ${capabilities.join(', ')}` }),
  );
