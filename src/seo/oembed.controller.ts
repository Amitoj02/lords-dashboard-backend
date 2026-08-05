import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';

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
  @Public()
  @Get()
  // Fetched once per unfurl alongside the HTML, so this shares the shells'
  // budget rather than getting a tighter one of its own.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  oembed(
    @Query('author') author: string | undefined,
    @Query('author_url') authorUrl: string | undefined,
    @Query('provider') provider: string | undefined,
    @Query('provider_url') providerUrl: string | undefined,
    @Res() res: Response,
  ): void {
    const payload = {
      version: '1.0',
      type: 'link',
      ...(provider ? { provider_name: clamp(provider) } : {}),
      ...(providerUrl && isHttpUrl(providerUrl) ? { provider_url: providerUrl } : {}),
      ...(author ? { author_name: clamp(author) } : {}),
      ...(authorUrl && isHttpUrl(authorUrl) ? { author_url: authorUrl } : {}),
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Matches the shells' ten minutes. The two documents describe one page and
    // there is no reason for one of them to go stale ahead of the other.
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(payload);
  }
}

function clamp(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > FIELD_LIMIT ? collapsed.slice(0, FIELD_LIMIT) : collapsed;
}

/**
 * A URL field is only emitted when it is one — and specifically not when it is
 * `javascript:`.
 *
 * These values are ours today, composed server-side from a member's id. They are
 * still checked, because the only thing standing between "ours" and "anyone's"
 * is that nobody has yet written a caller that forwards a parameter, and
 * `author_url` becomes the click target of a line inside a Discord embed.
 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
