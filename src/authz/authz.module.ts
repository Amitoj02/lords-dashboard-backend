import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordIdentity } from '../auth/entities/discord-identity.entity';
import { SessionContextService } from '../auth/session-context.service';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { AuthzService } from './authz.service';
import { RolePermission } from './entities/role-permission.entity';
import { AnyCapabilityGuard } from './guards/any-capability.guard';
import { CapabilitiesGuard } from './guards/capabilities.guard';

/**
 * Cross-cutting authorization. Declared @Global so any feature module can use
 * @RequireCapability(...) and resolve the caller's live context without
 * re-importing it. Exports:
 *  - AuthzService — the cached capability × role matrix (for guards + /auth/me).
 *  - CapabilitiesGuard — so Nest can resolve it wherever @UseGuards references it.
 *  - SessionContextService — resolves role/regiment/member fresh per request
 *    (T-0046) and hosts session invalidation (T-0048). Lives here (global) so
 *    the JwtStrategy and every mutation that changes a member's role/session can
 *    inject it without a web of module imports.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RolePermission, DiscordIdentity, Member, Regiment])],
  providers: [AuthzService, CapabilitiesGuard, AnyCapabilityGuard, SessionContextService],
  exports: [AuthzService, CapabilitiesGuard, AnyCapabilityGuard, SessionContextService],
})
export class AuthzModule {}
