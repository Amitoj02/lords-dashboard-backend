import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthzService } from './authz.service';
import { RolePermission } from './entities/role-permission.entity';
import { CapabilitiesGuard } from './guards/capabilities.guard';

/**
 * Cross-cutting authorization. Declared @Global so any feature module can use
 * @RequireCapability(...) without re-importing it. Exports AuthzService (for
 * capability lookups, e.g. /auth/me enrichment) and CapabilitiesGuard (so Nest
 * can resolve it via DI wherever @UseGuards references it).
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RolePermission])],
  providers: [AuthzService, CapabilitiesGuard],
  exports: [AuthzService, CapabilitiesGuard],
})
export class AuthzModule {}
