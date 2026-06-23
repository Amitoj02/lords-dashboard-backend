import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { Capability } from '../../common/enums';
import { CAPABILITY_KEY, CapabilitiesGuard } from '../guards/capabilities.guard';

/**
 * Gate a route (or controller) on one or more capabilities from the
 * role_permissions matrix. Applies the metadata, wires the CapabilitiesGuard
 * and documents the 403 in Swagger in one shot:
 *
 *   @RequireCapability(Capability.ViewAuditLog)
 *   @Get('audit')
 *   findAudit() { ... }
 *
 * Pair with @ApiBearerAuth('access-token') on the controller for docs.
 */
export const RequireCapability = (...capabilities: Capability[]) =>
  applyDecorators(
    SetMetadata(CAPABILITY_KEY, capabilities),
    UseGuards(CapabilitiesGuard),
    ApiForbiddenResponse({ description: `Requires capability: ${capabilities.join(', ')}` }),
  );
