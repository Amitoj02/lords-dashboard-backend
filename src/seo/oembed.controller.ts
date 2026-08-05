import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AppConfig } from '../config/configuration';

/**
 * The longest `author_name` this endpoint will echo back.
 *
 * Discord truncates the line itself, but it is doing so on a string WE put in a
 * URL, and an unbounded query parameter reflected into a response body is a
 * reflection surface whether or not the content type makes it exploitable.
 * FxEmbed cuts at 255 for the same reason; there is no reason to be looser.
 */
const FIELD_LIMIT = 255;

/**
 * `/api/oembed` — the author line on a Discord embed (T-0297).
 *
 * ── WHY THIS ENDPOINT EXISTS AT ALL ─────────────────────────────────────────
 * Every other field on a link preview is an Open Graph tag, and the shell in
 * `page-shell.ts` emits all of them. One field is not reachable that way: the
 * small bold line ABOVE the title. Discord fills it from oEmbed `author_name`
 * and from nothing else — there is no `og:` equivalent, and `article:author` is
 * not read. Without it a shared profile leads with a title; with it, the card
 * opens "Captain · 9 decorations" and *then* names the member.
 *
 * `provider_name` lands in the same slot as `og:site_name` (the small grey line
 * above the author). Both are returned so that the two lines are decided in one
 * place rather than half here and half in the meta tags.
 *
 * ── WHY IT IS STATELESS, AND WHY THAT IS THE WHOLE DESIGN ───────────────────
 * The obvious shape is `?url=<the page>` — resolve it, look the entity up,
 * return its facts. This does the opposite: the caller (our own shell) puts the
 * finished strings in the query, and this handler echoes them into oEmbed's
 * JSON envelope. That buys three things that matter more than elegance here:
 *
 *   1. NO DATABASE HIT. Discord fetches the HTML and the oEmbed URL as separate
 *      requests inside a ~5 second unfurl budget, and the second one arriving
 *      with no work to do is the difference between a card and no card when the
 *      box is busy.
 *   2. NO SECOND SOURCE OF TRUTH. The author line is composed once, in
 *      `SeoService`, next to the title and description it has to agree with. A
 *      resolver here would be a parallel implementation of every projection in
 *      the app, free to drift from the document it annotates.
 *   3. NO URL PARSING. `?url=` would mean re-deriving "which page is this" from
 *      a string, including the `/u/@handle` vs `/u/<id>` split — logic that
 *      already exists and that a crawler-facing endpoint should not own a second
 *      copy of.
 *
 * The strings are public facts already printed in the same document's `<head>`,
 * so putting them in a query string discloses nothing new.
 *
 * ── WHY `type: 'link'` ──────────────────────────────────────────────────────
 * oEmbed's `rich` type REQUIRES `html`, and Discord discards the entire oEmbed
 * response if it does not validate — losing the author line rather than
 * degrading. It also refuses to render a non-allowlisted `html` payload, so
 * `rich` would cost a required field to buy something that is dropped anyway.
 * `link` needs only `version` and `type`, which is exactly what is on offer.
 */
@ApiExcludeController()
@Controller('oembed')
export class OEmbedController {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  @Public()
  @Get()
  // Fetched once per unfurl alongside the HTML, so it gets the shells' ceiling
  // rather than a tighter one of its own — see `SHELL_RATE_LIMIT` in
  // `seo.controller.ts` for why 60 was not enough once the routing went live.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  oembed(
    @Query('author') author: unknown,
    @Query('author_url') authorUrl: unknown,
    @Query('provider') provider: unknown,
    @Query('provider_url') providerUrl: unknown,
    @Res() res: Response,
  ): void {
    // ── EVERY PARAMETER IS `unknown` UNTIL `str()` HAS SEEN IT ────────────────
    // These were typed `string | undefined`, which is a claim Express does not
    // honour: its `qs` parser yields a `string[]` for a repeated key and a plain
    // object for a bracketed one, and the global ValidationPipe does not coerce
    // a String-typed `@Query` (it converts only Number and Boolean). So
    // `?author=a&author=b` reached `.replace` on an array and returned a 500
    // from a `@Public()` route, and `?author_url=https://ok&author_url=javascript:…`
    // slipped past the scheme check entirely — `RegExp.test` stringifies its
    // argument, so the array joined to a string that began with `https://` and
    // matched, after which the ARRAY was spread into the response.
    const origin = this.siteOrigin();
    const payload = {
      version: '1.0',
      type: 'link',
      ...field('provider_name', str(provider)),
      ...urlField('provider_url', str(providerUrl), origin),
      ...field('author_name', str(author)),
      ...urlField('author_url', str(authorUrl), origin),
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Matches the shells' ten minutes. The two documents describe one page and
    // there is no reason for one of them to go stale ahead of the other.
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(payload);
  }

  /**
   * The only origin a URL field may point at.
   *
   * `undefined` when the site URL is unset or unparseable, which relaxes
   * {@link urlField} to a scheme check rather than rejecting every URL — a
   * misconfigured `FRONTEND_URL` should cost the author line's link, not the
   * whole oEmbed response, because an invalid response is discarded by Discord
   * and takes the author line with it.
   */
  private siteOrigin(): string | undefined {
    const configured = this.config.get('frontend', { infer: true }).url;
    if (!configured) return undefined;
    try {
      return new URL(configured).origin;
    } catch {
      return undefined;
    }
  }
}

/**
 * The single narrowing point: anything that is not a plain string becomes null.
 *
 * Not `String(value)` — an array must be REJECTED, not joined. Coercing
 * `['https://ok', 'javascript:…']` into one string is precisely how the scheme
 * check was defeated, and a joined value is not something a caller asked for
 * either way.
 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A text field, whitespace-collapsed and length-capped, or nothing. */
function field(key: string, value: string | null): Record<string, string> {
  if (!value) return {};
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return {};
  return { [key]: collapsed.length > FIELD_LIMIT ? collapsed.slice(0, FIELD_LIMIT) : collapsed };
}

/**
 * A URL field, emitted only when it points at THIS site.
 *
 * The check used to be "does it start with http(s)", which let any third party
 * put a discovery `<link>` on their own page naming this endpoint and have the
 * regiment's apex domain serve the author line for a URL of their choosing.
 * They gain little — they control their own page's tags anyway — but there is
 * no call site that legitimately needs an off-site URL here: the shell composes
 * both of these from `siteUrl()`, so anything else is by definition not ours.
 *
 * `URL` parsing rather than a prefix match, because `https://lordsofholdfast.com.evil.test/`
 * passes `startsWith` and is a different origin.
 */
function urlField(key: string, value: string | null, origin?: string): Record<string, string> {
  if (!value) return {};
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {};
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return {};
  if (origin && parsed.origin !== origin) return {};
  return { [key]: parsed.toString() };
}
