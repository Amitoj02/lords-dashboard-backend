import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { GalleryController } from './gallery.controller';
import { GalleryService } from './gallery.service';
import { GalleryFile } from './entities/gallery-file.entity';
import { GalleryItem } from './entities/gallery-item.entity';
import { GalleryLike } from './entities/gallery-like.entity';
import { GalleryTaggedMember } from './entities/gallery-tagged-member.entity';

/**
 * Gallery module. Registers the item + its child tables (files, likes, tagged
 * members), the Member repo (author/tag name resolution + tag validation) and
 * RegimentSettings (public-visibility flag + submission limits). AuditService is
 * global and DataSource (used for the submit transaction) is provided by the
 * root TypeOrmModule, so neither is imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      GalleryItem,
      GalleryFile,
      GalleryLike,
      GalleryTaggedMember,
      Member,
      RegimentSettings,
    ]),
  ],
  controllers: [GalleryController],
  providers: [GalleryService],
  exports: [GalleryService],
})
export class GalleryModule {}
