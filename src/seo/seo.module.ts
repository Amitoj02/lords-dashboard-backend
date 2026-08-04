import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { RegimentsModule } from '../regiments/regiments.module';
import { SeoController, SitemapController } from './seo.controller';
import { SeoService } from './seo.service';

/**
 * Server-rendered HTML for search engines and link unfurlers (T-0215).
 *
 * Owns no data. It imports {@link MembersModule} for `PublicMembersService` and
 * {@link RegimentsModule} for the regiment name, and renders exactly what those
 * already return — which is the property that keeps the crawler's view and the
 * human's view from drifting apart into cloaking.
 *
 * The gallery's own share shell stays where it is, in `GalleryModule`: it is
 * older, it is reached through a separate Caddy rule, and moving it would break
 * the `/api/share/gallery/:id` path that an un-synced Caddyfile on the box is
 * still pointing at.
 */
@Module({
  imports: [MembersModule, RegimentsModule],
  controllers: [SeoController, SitemapController],
  providers: [SeoService],
})
export class SeoModule {}
