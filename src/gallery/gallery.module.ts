import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordModule } from '../discord/discord.module';
import { Member } from '../members/entities/member.entity';
import { RegimentSettings } from '../regiments/entities/regiment-settings.entity';
import { RegimentsModule } from '../regiments/regiments.module';
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
import { GalleryView } from './entities/gallery-view.entity';

/**
 * Gallery module. Registers the item + its child tables (files, likes, views,
 * tags), the Member repo (author name resolution + decline-DM identity lookup) and
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
      GalleryView,
      Member,
      RegimentSettings,
    ]),
    // Resolves uploaded file keys to public URLs (StorageService).
    StorageModule,
    // Best-effort decline DMs to submitters via the discord-sync outbox.
    DiscordModule,
    // The regiment's own name, for the share shells (T-0293). They used to
    // hardcode "Lords Regiment" while every other crawler surface read the
    // editable one, so a renamed regiment stayed renamed everywhere except in
    // its own link previews. RegimentsModule imports nothing that reaches back
    // here, so this edge cannot cycle.
    RegimentsModule,
  ],
  controllers: [GalleryController, MediaController, GalleryShareController],
  providers: [GalleryService, MediaEmbedService, GalleryShareService],
  // GalleryShareService is exported so SeoModule can mount the same renderer at
  // `/api/seo/gallery/*` (T-0293) without a second implementation of the card.
  // The `/api/share/gallery/:id` controller below stays exactly where it is —
  // an un-synced Caddyfile on the box still rewrites to that path.
  exports: [GalleryService, GalleryShareService],
})
export class GalleryModule {}
