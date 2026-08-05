import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { GalleryModule } from '../gallery/gallery.module';
import { MembersModule } from '../members/members.module';
import { RegimentsModule } from '../regiments/regiments.module';
import { SeoController, SitemapController } from './seo.controller';
import { SeoService } from './seo.service';

/**
 * Server-rendered HTML for search engines and link unfurlers (T-0215, widened
 * in T-0293).
 *
 * Owns no data. It imports {@link MembersModule} for `PublicMembersService`,
 * {@link RegimentsModule} for the regiment's name and presentation,
 * {@link EventsModule} for the public calendar and {@link GalleryModule} for the
 * gallery — and renders exactly what those already return, which is the property
 * that keeps the crawler's view and the human's view from drifting apart into
 * cloaking.
 *
 * ── NO CYCLES, AND THAT IS NOT AN ACCIDENT ──────────────────────────────────
 * Every edge here points AWAY from the feature modules: nothing under
 * `members/`, `events/`, `gallery/` or `regiments/` imports `SeoModule`. The one
 * edge that could have cycled — the gallery share shell wanting a member's
 * handle so it could link an author's profile — is deliberately not taken (see
 * `GalleryShareService`), because `MembersModule` already imports
 * `GalleryModule`.
 *
 * ── THE GALLERY SHELL STAYS WHERE IT IS ─────────────────────────────────────
 * `GalleryShareService` is imported, not moved. Its own controller keeps serving
 * `/api/share/gallery/:id`, because an un-synced Caddyfile on the production box
 * still rewrites unfurlers to that path, and this module mounts the SAME
 * renderer at `/api/seo/gallery/:id` for the matcher that supersedes it. One
 * implementation, two paths, and therefore no window in which a share link
 * renders differently depending on which of them the edge happened to pick.
 */
@Module({
  imports: [MembersModule, RegimentsModule, EventsModule, GalleryModule],
  controllers: [SeoController, SitemapController],
  providers: [SeoService],
})
export class SeoModule {}
