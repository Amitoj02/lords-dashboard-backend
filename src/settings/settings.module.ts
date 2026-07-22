import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RolePermission } from '../authz/entities/role-permission.entity';
import { Member } from '../members/entities/member.entity';
import { RegimentDocument } from '../regiments/entities/regiment-document.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { StorageModule } from '../storage/storage.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Regiment control-panel module. Registers the repositories the service reads
 * from/writes to: regiment_settings + regiment (profile/settings + lifecycle),
 * role_permissions (the authorization matrix), members (ownership transfer) and
 * regiment_documents (the editable legal pages, T-0149). StorageModule is
 * imported so the presentation route can re-validate an uploaded banner key's
 * namespace before persisting it (T-0148). AuthzService and AuditService are
 * provided globally, so they are injected directly rather than imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegimentSettings,
      Regiment,
      RolePermission,
      Member,
      RegimentDocument,
    ]),
    StorageModule,
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
