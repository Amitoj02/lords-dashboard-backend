import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordModule } from '../discord/discord.module';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { StorageModule } from '../storage/storage.module';
import { GalleryController } from './gallery.controller';
import { GalleryService } from './gallery.service';
import { MediaController } from './media/media.controller';
import { MediaEmbedService } from './media/media-embed.service';
import { GalleryShareController } from './share/gallery-share.controller';
import { GalleryShareService } from './share/gallery-share.service';
import { GalleryFile } from './entities/gallery-file.entity';
import { GalleryItem } from './entities/gallery-item.entity';
import { GalleryLike } from './entities/gallery-like.entity';
import { GalleryTag } from './entities/gallery-tag.entity';

/**
 * Gallery module. Registers the item + its child tables (files, likes, tags),
 * the Member repo (author name resolution + decline-DM identity lookup) and
 * RegimentSettings (public-visibility flag + submission limits). AuditService is
 * global and DataSource (used for the submit transaction) is provided by the
 * root TypeOrmModule. DiscordModule is imported for the decline DM and the
 * review / showcase channel posts.
 *
 * THREE controllers, on three non-overlapping prefixes: `gallery` (the API),
 * `gallery/media` (link resolution, kept off `gallery/:id`), and `share` (the
 * server-rendered Open Graph shells a link unfurler reads — deliberately NOT
 * under `gallery`, so the Caddy rewrite that routes crawlers here is one line).
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
  controllers: [GalleryController, MediaController, GalleryShareController],
  providers: [GalleryService, MediaEmbedService, GalleryShareService],
  exports: [GalleryService],
})
export class GalleryModule {}
