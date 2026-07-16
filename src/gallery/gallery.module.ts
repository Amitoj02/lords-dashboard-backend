import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordModule } from '../discord/discord.module';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { StorageModule } from '../storage/storage.module';
import { GalleryController } from './gallery.controller';
import { GalleryService } from './gallery.service';
import { GalleryFile } from './entities/gallery-file.entity';
import { GalleryItem } from './entities/gallery-item.entity';
import { GalleryLike } from './entities/gallery-like.entity';
import { GalleryTag } from './entities/gallery-tag.entity';

/**
 * Gallery module. Registers the item + its child tables (files, likes, tags),
 * the Member repo (author name resolution + decline-DM identity lookup) and
 * RegimentSettings (public-visibility flag + submission limits). AuditService is
 * global and DataSource (used for the submit transaction) is provided by the
 * root TypeOrmModule. DiscordModule is imported for best-effort decline DMs.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      GalleryItem,
      GalleryFile,
      GalleryLike,
      GalleryTag,
      Member,
      RegimentSettings,
    ]),
    // Resolves uploaded file keys to public URLs (StorageService).
    StorageModule,
    // Best-effort decline DMs to submitters via the discord-sync outbox.
    DiscordModule,
  ],
  controllers: [GalleryController],
  providers: [GalleryService],
  exports: [GalleryService],
})
export class GalleryModule {}
