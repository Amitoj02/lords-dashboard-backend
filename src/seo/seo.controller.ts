import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SHORT_ID_REGEX } from '../common/ids/short-id';
import { SeoService } from './seo.service';

/**
 * Requests per minute, per tracked client, for one shell route (T-0297).
 *
 * ── WHY 300 AND NOT THE 60 IT WAS ───────────────────────────────────────────
 * `CfAwareThrottlerGuard` keys on `req.ip` unless `TRUST_CF_CONNECTING_IP=true`,
 * and behind the edge that address is the proxy, not the crawler. Every
 * unfurler and every search engine on earth therefore shares ONE bucket per
 * route. That cost nothing while the rewrite was dead — nothing reached these
 * routes at all — and became live the moment the routing shipped inside the web
 * image.
 *
 * `u/:handle` is the binding constraint: it is one route serving every profile
 * on the site, so a Googlebot pass over a few hundred members runs through 60
 * requests in well under a minute and the rest of the crawl gets 429s, which
 * Google reads as "slow down" and can hold for days.
 *
 * The buckets ARE per-route, so this cannot starve a signed-in member — they
 * are on different routes entirely. The blast radius is crawlers starving each
 * other, which is still the failure this module exists to prevent. 300/min
 * absorbs a full crawl while leaving these public, uncached-by-us endpoints
 * bounded. The real fix is Authenticated Origin Pulls plus
 * `TRUST_CF_CONNECTING_IP=true`, so each crawler gets a bucket of its own; the
 * ordering that makes that sound is in `deploy/README.md`.
 */
const SHELL_RATE_LIMIT = 300;

/**
 * The crawler-facing surface (T-0215).
 *
 * ── HOW A CRAWLER GETS HERE ─────────────────────────────────────────────────
 * `https://lordsofholdfast.com/u/@panda` is an SPA route, and the SPA is a
 * static build: without a rewrite a crawler receives one
 * `<app-root></app-root>`, identical for every URL on the site. TWO layers now
 * match known crawler user-agents and rewrite them here.
 *
 * The frontend repo's `nginx.conf` is the one that reliably ships: it lives
 * inside the `web` image and reaches production on any ordinary
 * `deploy web <tag>`. The `Caddyfile` in this repo carries the same matcher and
 * takes precedence when it is current — but it is HAND-SYNCED, `lords-deploy`
 * has no command that can write it, and for months it was not synced at all, so
 * every route below served correct HTML that nothing ever requested. Caddy's
 * `handle` blocks are mutually exclusive, so whichever layer is live answers and
 * the two cannot disagree: both proxy the same path to the same routes.
 *
 * ── WHY THE STATUS CODES MATTER HERE MORE THAN ANYWHERE ELSE ────────────────
 * The SPA cannot return one. Angular's wildcard route redirects every unknown
 * URL to `/home` and nginx 200s everything, so a deleted profile, a renamed
 * handle and a typo all currently return `200 OK` with the landing page — a
 * soft-404, which Google reads as a signal to stop trusting the whole URL
 * pattern. This controller is the only place that can answer 404 and 410
 * honestly, and it does: whatever `PublicMembersService` throws is what the
 * crawler is told.
 */
@ApiExcludeController()
@Controller('seo')
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  @Public()
  @Get('roster')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async roster(@Query('page') page: string, @Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderRoster(Number(page ?? '1')));
  }

  @Public()
  @Get('u/:handle')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async profile(@Param('handle') handle: string, @Res() res: Response): Promise<void> {
    // Not wrapped in a try/catch: a 404 or 410 from the service IS the answer a
    // crawler needs. Swallowing it into a generic card — the way the gallery
    // share shell deliberately does, because a Discord unfurl of a 404 renders
    // as a broken preview — would leave every dead profile looking alive to a
    // search engine and permanently indexed.
    this.sendHtml(res, await this.seo.renderProfile(handle));
  }

  /**
   * The landing page (T-0293).
   *
   * `/home`, never `/`. The router redirects the root to `/home`, so `/home` is
   * the URL both surfaces declare canonical — and `/` is the one path a
   * Cloudflare Cache Rule covers, which is why the Caddy matcher deliberately
   * excludes it. Routing a cached path by User-Agent puts this document one
   * cache HIT away from every human visitor.
   */
  @Public()
  @Get('home')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async home(@Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderHome());
  }

  @Public()
  @Get('events')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async events(@Query('page') page: string, @Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderEvents(Number(page ?? '1')));
  }

  /**
   * One event. Like `u/:handle`, the service's status code IS the answer: 404
   * for an event that is missing, drafted, archived or deleted; 403 for a
   * regiment that has made its calendar private.
   *
   * The id is tested against {@link SHORT_ID_REGEX} here rather than piped
   * through `ParseShortIdPipe`, so a typo renders the generic site card instead
   * of the 400 JSON body an unfurler would show as a broken link.
   */
  @Public()
  @Get('events/:id')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async event(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!SHORT_ID_REGEX.test(id)) {
      this.sendHtml(res, await this.seo.renderFallback());
      return;
    }
    this.sendHtml(res, await this.seo.renderEvent(id));
  }

  @Public()
  @Get('gallery')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async gallery(@Query('page') page: string, @Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderGallery(Number(page ?? '1')));
  }

  /**
   * One gallery item — the same renderer `/api/share/gallery/:id` has always
   * used, mounted here so one Caddy matcher can cover the whole public site.
   *
   * Unlike the profile and event routes, this one NEVER surfaces a 404. A
   * dispatch is the thing people paste into a chat, and Discord renders a 404
   * body as a broken preview rather than as a card that says the item is gone.
   * The generic card it falls back to is `noIndex`, so a dead id still cannot
   * be indexed as though it resolved.
   */
  @Public()
  @Get('gallery/:id')
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async galleryItem(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const html = SHORT_ID_REGEX.test(id)
      ? await this.seo.renderGalleryItem(id)
      : await this.seo.renderFallback();
    this.sendHtml(res, html);
  }

  /** Anything else under the matcher: the generic site card, never a 500. */
  @Public()
  @Get()
  @Throttle({ default: { limit: SHELL_RATE_LIMIT, ttl: 60_000 } })
  async fallback(@Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderFallback());
  }

  private sendHtml(res: Response, html: string): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Overrides the app-wide `no-store` set in main.ts before routing. Ten
    // minutes absorbs a crawl burst on one URL without letting a renamed handle
    // stay stale for long.
    res.setHeader('Cache-Control', 'public, max-age=600');
    // `User-Agent` is named because the EDGE reached this document by matching
    // one (T-0293): the same public URL returns the Angular app to a browser, so
    // a shared cache holding this copy without keying on the UA would serve the
    // crawler shell to humans. Cloudflare honours `Vary` for `Accept-Encoding`
    // and nothing else, which is exactly why the matcher must never be widened
    // to a path a Cloudflare Cache Rule covers — see the Caddyfile.
    res.setHeader('Vary', 'User-Agent, Accept-Encoding');
    res.send(html);
  }
}

/**
 * `/sitemap.xml`, mounted at the API root rather than under `/seo` so the Caddy
 * rewrite is a single literal path.
 */
@ApiExcludeController()
@Controller()
export class SitemapController {
  constructor(private readonly seo: SeoService) {}

  @Public()
  @Get('sitemap.xml')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async sitemap(@Res() res: Response): Promise<void> {
    const xml = await this.seo.renderSitemap();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    // An hour: long enough that a crawler re-fetching it costs nothing, short
    // enough that a member who claims a handle is discoverable the same day.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  }
}
