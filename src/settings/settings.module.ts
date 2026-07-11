import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolePermission } from '../authz/entities/role-permission.entity';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Regiment control-panel module. Registers the repositories the service reads
 * from/writes to: regiment_settings + regiment (profile/settings + lifecycle),
 * role_permissions (the authorization matrix) and members (ownership transfer).
 * AuthzService and AuditService are provided globally, so they are injected
 * directly rather than imported here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RegimentSettings, Regiment, RolePermission, Member])],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
