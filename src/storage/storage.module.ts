import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/**
 * Object-storage module (T-0065/T-0066). Provides {@link StorageService} — the
 * presigned-upload issuer + key-namespace validator — and exports it so every
 * feature module (members, events, medals, ranks, gallery) can resolve an
 * uploaded key to a public URL. RegimentSettings is registered for the gallery
 * per-regiment size caps. AuthzService is global (AuthzModule).
 */
@Module({
  imports: [TypeOrmModule.forFeature([RegimentSettings])],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
