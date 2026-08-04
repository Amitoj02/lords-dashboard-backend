import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SeoService } from './seo.service';

/**
 * The crawler-facing surface (T-0215).
 *
 * ── HOW A CRAWLER GETS HERE ─────────────────────────────────────────────────
 * `https://lordsofholdfast.com/u/@panda` is an SPA route: Caddy hands it to the
 * static nginx image, which returns the un-templated Angular shell — one
 * `<app-root></app-root>` and nothing else, identical for every URL on the
 * site. The Caddyfile matches known crawler user-agents on `/u/*` and `/roster`
 * and rewrites them to this controller, while every human still gets the app.
 *
 * That rewrite is a MANUAL change on the box. `lords-deploy` only ever pins
 * image tags and pulls — it never syncs the Caddyfile — so shipping this code
 * does nothing until someone SSHes in and updates the proxy. The runbook step
 * is written up in `deploy/README.md`; until it runs, these routes are only
 * reachable directly, which is exactly how they should be tested first.
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
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async roster(@Query('page') page: string, @Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderRoster(Number(page ?? '1')));
  }

  @Public()
  @Get('u/:handle')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async profile(@Param('handle') handle: string, @Res() res: Response): Promise<void> {
    // Not wrapped in a try/catch: a 404 or 410 from the service IS the answer a
    // crawler needs. Swallowing it into a generic card — the way the gallery
    // share shell deliberately does, because a Discord unfurl of a 404 renders
    // as a broken preview — would leave every dead profile looking alive to a
    // search engine and permanently indexed.
    this.sendHtml(res, await this.seo.renderProfile(handle));
  }

  /** Anything else under the matcher: the generic site card, never a 500. */
  @Public()
  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async fallback(@Res() res: Response): Promise<void> {
    this.sendHtml(res, await this.seo.renderFallback());
  }

  private sendHtml(res: Response, html: string): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Overrides the app-wide `no-store` set in main.ts before routing. Ten
    // minutes absorbs a crawl burst on one URL without letting a renamed handle
    // stay stale for long.
    res.setHeader('Cache-Control', 'public, max-age=600');
    // The document varies only by path, never by cookie — worth saying out loud
    // on a cacheable response that is reachable with a session cookie set.
    res.setHeader('Vary', 'Accept-Encoding');
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
