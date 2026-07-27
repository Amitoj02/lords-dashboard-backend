import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { SHORT_ID_REGEX } from '../../common/ids/short-id';
import { GalleryShareService } from './gallery-share.service';

/**
 * Server-rendered Open Graph shells for public share links (T-0197).
 *
 * ── HOW A CRAWLER GETS HERE ─────────────────────────────────────────────────
 * `https://lordsofholdfast.com/gallery/<id>` is an SPA route: Caddy sends it to
 * the static nginx image, which returns the un-templated Angular shell. The
 * Caddyfile matches known unfurler user-agents on `/gallery/*` and rewrites
 * them to `/api/share/gallery/<id>` — this route — while every human still gets
 * the real app. The path shape is what makes that rewrite a single line.
 *
 * The route is also directly linkable, so it stands on its own if the Caddy
 * matcher is ever removed: opening it in a browser bounces to the SPA.
 *
 * ── WHY IT IS DELIBERATELY DULL ─────────────────────────────────────────────
 * Unauthenticated, so it does exactly two things: read one already-public
 * gallery item, and print escaped text. No outbound fetch, no user input
 * reaching a query, no capability check to get wrong. Anything an id does not
 * resolve to gets the generic site card — a 404 body would render in Discord as
 * a broken preview, and "which ids exist" is not something an unfurl should
 * answer either way.
 */
@ApiExcludeController()
@Controller('share')
export class GalleryShareController {
  constructor(private readonly share: GalleryShareService) {}

  @Public()
  @Get('gallery/:id')
  // Unauthenticated and HTML-rendering, so it gets its own bucket well under
  // the global one — the same treatment as the public medal-thumbnail proxy.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async galleryItem(@Param('id') id: string, @Res() res: Response): Promise<void> {
    // Validated here rather than with ParseShortIdPipe: a malformed id must
    // render the generic card, not a 400 JSON body that an unfurler would show
    // as a broken link.
    const html = SHORT_ID_REGEX.test(id)
      ? ((await this.share.renderItem(id)) ?? this.share.renderFallback())
      : this.share.renderFallback();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Overrides the app-wide `no-store`. Unfurlers cache aggressively anyway and
    // this is public, immutable-ish content; ten minutes keeps a re-titled item
    // from staying stale for long while absorbing a burst of crawlers on one link.
    res.setHeader('Cache-Control', 'public, max-age=600');
    // The card varies only by id, never by cookie — say so explicitly, since the
    // response is cacheable and the route is reachable with a session cookie set.
    res.setHeader('Vary', 'Accept-Encoding');
    res.send(html);
  }
}
