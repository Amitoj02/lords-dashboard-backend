import { escapeHtml } from './escape-html';

/** One `<a>` in a rendered list. */
export interface ShellLink {
  href: string;
  label: string;
  /** Optional muted second line (rank, date, caption…). */
  meta?: string | null;
  /**
   * `rel` for this anchor, omitted entirely when absent (T-0216).
   *
   * Every link this shell rendered before now pointed at our own site, where a
   * `rel` would be noise. Member social links do not: they are the first
   * MEMBER-AUTHORED outbound links on the origin, so they carry
   * `rel="nofollow ugc"` — `ugc` says the destination was chosen by a user and
   * not by us, and `nofollow` stops a member's own profile page from spending
   * this domain's crawl equity on it. The set of hosts is closed (the seven in
   * the social-platform registry) and the URL is composed server-side from a
   * stored handle, so this is reputational hygiene rather than a containment
   * measure — the containment is that a member cannot name the host at all.
   */
  rel?: string;
}

/** A `<dt>/<dd>` pair in the facts list. */
export interface ShellFact {
  label: string;
  value: string;
}

/**
 * The card image (T-0293).
 *
 * `width`/`height` are not decoration. Discord decides between a small
 * right-hand thumbnail and a full-width hero from the image it fetches, and
 * declaring the dimensions lets it lay the embed out before that fetch
 * finishes — the difference between a card that appears at full size and one
 * that reflows once the bytes land. They are omitted when unknown rather than
 * guessed: a wrong pair is worse than none, because the unfurler reserves the
 * space it was told about.
 */
export interface ShellImage {
  url: string;
  /** Alt text. Read out by screen readers on Twitter/X, and used by Google Images. */
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  /** `image/png`, `image/webp`… Omitted when the extension is unrecognised. */
  type?: string | null;
  /**
   * Which card this image can actually fill.
   *
   * Discord inspects the FILE, not only the tags: a square or portrait image
   * asked to fill a `summary_large_image` card is frequently demoted to the
   * right-hand thumbnail anyway, and the result is a card that looks broken
   * rather than one that looks small. A member's avatar is square by
   * construction, so a profile with no banner declares `summary` and gets the
   * neat thumbnail-beside-the-text layout on purpose. `wide` is the default
   * because every other image on this site is a 16:9 banner or screenshot.
   */
  shape?: 'wide' | 'square';
}

/**
 * A playable video (T-0293).
 *
 * `type` is `video/mp4` or `video/webm` for an uploaded file — Discord plays
 * those inline straight from the URL — and `text/html` for an external embed
 * page, which it renders as a click-to-play frame for the providers it knows.
 */
export interface ShellVideo {
  url: string;
  type: string;
  width?: number | null;
  height?: number | null;
  /** Runtime in seconds, when the file carries one. */
  durationSeconds?: number | null;
}

/**
 * Media rendered into the BODY, not just the head (T-0293).
 *
 * The head tags are for the unfurler; this is for the human and for Googlebot's
 * rendered pass. A gallery page whose crawler shell described a photograph in
 * meta tags and then showed nothing at all would be the same thin-page problem
 * the facts list was added to solve, one medium over.
 */
export interface ShellMedia {
  kind: 'image' | 'video';
  url: string;
  /** Poster frame for a video. Ignored for an image. */
  posterUrl?: string | null;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  /** MIME type, emitted as `<source type>` so a browser can skip what it cannot play. */
  type?: string | null;
}

/** Everything the shell renders for one page. */
export interface ShellPage {
  canonicalUrl: string;
  siteName: string;
  title: string;
  description: string;
  /** The visible `<h1>`. Defaults to `title` when omitted. */
  heading?: string;
  /** A muted line under the heading (rank, role, date…). */
  subheading?: string | null;
  /**
   * The card image. A bare string is shorthand for `{ url }`, so every call
   * site that predates {@link ShellImage} keeps working and keeps emitting the
   * tags it emitted before.
   */
  imageUrl?: string | ShellImage | null;
  /** A playable video, for a page whose subject IS one. */
  video?: ShellVideo | null;
  /** Rendered into the body as a real `<img>`/`<video>`. */
  media?: ShellMedia | null;
  ogType?: 'website' | 'profile' | 'article' | 'video.other';
  /** Tell search engines not to index this page (suspended member, paginated tail…). */
  noIndex?: boolean;
  /**
   * The embed's accent colour, as `#rrggbb`.
   *
   * Discord draws the left edge of an embed in the page's `theme-color`, which
   * is the cheapest branding on the whole card: without it, every link from
   * this domain unfurls with the same neutral stripe as everyone else's.
   */
  themeColor?: string | null;
  /** ISO instants for a page with a publication date (an event, a dispatch). */
  publishedTime?: string | null;
  modifiedTime?: string | null;
  /**
   * Up to two key/value pairs Slack renders as fields under the unfurl.
   *
   * X ignores them and Discord ignores them, so this is the one tag pair that
   * buys nothing anywhere else — but a rank and a decoration count showing as
   * labelled fields in a Slack preview costs two lines of markup, and anything
   * past the second pair is silently dropped by Slack, so the slice is real.
   */
  labels?: { label: string; data: string }[];
  /** Prose paragraphs, rendered in order. */
  paragraphs?: string[];
  /** Labelled facts — the substance a thin page is missing. */
  facts?: ShellFact[];
  /** Named sections of links, each rendered as an `<h2>` + `<ul>`. */
  sections?: { heading: string; links: ShellLink[] }[];
  /** `rel=prev`/`rel=next` for a paginated list. */
  prevUrl?: string | null;
  nextUrl?: string | null;
  /** Serialized JSON-LD. Must already be JSON — it is escaped, not parsed. */
  jsonLd?: unknown;
}

/**
 * The crawler-facing HTML for a public page (T-0215, extended in T-0293).
 *
 * ── WHY THIS RENDERS REAL CONTENT AND NOT JUST META TAGS ────────────────────
 * The gallery share shell that preceded this one had exactly one job — feed an
 * unfurler an og:image — so a `<head>` full of meta tags and a single anchor in
 * the body was the whole document. That is the correct shape for Discord and
 * the WRONG shape for Google. Serving a search engine a stub while every human
 * gets a fully-populated Angular page is textbook cloaking, and it is a
 * manual-action risk regardless of intent.
 *
 * So this shell renders the SAME facts the SPA renders: the name, the rank, the
 * medals with their criteria, the join date, the event count, and real
 * crawlable `<a href>` links to the rest of the site. A human who lands here
 * (a UA that happens to match the matcher, or someone opening the API URL
 * directly) gets a plain but complete and readable page — not a redirect.
 *
 * ── AND WHY IT NOW CARRIES THE FULL UNFURLER TAG SET TOO (T-0293) ───────────
 * The two audiences want different things and one document has to satisfy both,
 * because ONE response is served to whichever of them asked. Google wants
 * prose, headings, links and JSON-LD; Discord reads `<head>` and stops. When
 * the gallery card moved onto this renderer it brought `og:video`,
 * `twitter:player` and the image dimensions with it, so there is now a single
 * place where "what a share looks like" is decided rather than two that drift.
 *
 * ── WHY THERE IS NO `<meta http-equiv="refresh">` ───────────────────────────
 * Its predecessor emitted one pointing at `canonicalUrl` — which is the URL the
 * crawler had just requested and been rewritten from. Googlebot follows a
 * 0-second refresh as a redirect, re-requests, matches the same UA rule and
 * gets the same refresh: a loop, reported as "Page with redirect", and
 * invisible in Google's own URL Inspection tool because that sends
 * `Google-InspectionTool`, which the matcher does not match. `rel=canonical`
 * does the consolidation work a refresh was never the right tool for.
 *
 * ── WHY A TEMPLATE STRING AND NOT AN .html FILE ─────────────────────────────
 * `nest-cli.json` declares no `compilerOptions.assets`, so non-`.ts` files under
 * `src/` are never copied into `dist/`, and the production image ships only
 * `dist/`. An `.html` template would work locally and 500 in the container.
 *
 * Every interpolated value goes through `escapeHtml`. Member-authored text
 * (in-game names, handles, captions, medal citations) reaches this document,
 * and it is served from the site's own origin — an unescaped `"` closing an
 * attribute would be stored XSS on the apex domain.
 */
export function renderPageShell(page: ShellPage): string {
  const canonical = escapeHtml(page.canonicalUrl);
  const heading = page.heading ?? page.title;
  const image = normaliseImage(page.imageUrl);
  const video = page.video ? sizeForDiscord(page.video) : null;

  const head = [
    `    <title>${escapeHtml(page.title)}</title>`,
    named('description', page.description),
    `    <link rel="canonical" href="${canonical}" />`,
    page.noIndex
      ? '    <meta name="robots" content="noindex, follow" />'
      : // `max-image-preview:large` is opt-in — the default for a site that
        // says nothing is `standard`, a thumbnail. On a regiment's gallery and
        // its members' portraits, the full-width preview in a search result is
        // the entire reason the image is there. `max-snippet:-1` lifts the
        // snippet length cap for the same reason.
        '    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />',
    page.prevUrl ? `    <link rel="prev" href="${escapeHtml(page.prevUrl)}" />` : '',
    page.nextUrl ? `    <link rel="next" href="${escapeHtml(page.nextUrl)}" />` : '',
    named('theme-color', page.themeColor),
    meta('og:site_name', page.siteName),
    meta('og:type', page.ogType ?? 'website'),
    meta('og:locale', 'en_GB'),
    meta('og:url', page.canonicalUrl),
    meta('og:title', page.title),
    meta('og:description', page.description),
    ...imageTags(image),
    ...videoTags(video),
    // `article:*` only means anything on an article-shaped page, and Discord
    // renders the published date as the embed's timestamp footer.
    page.publishedTime ? meta('article:published_time', page.publishedTime) : '',
    page.modifiedTime ? meta('article:modified_time', page.modifiedTime) : '',
    named('twitter:card', twitterCard(image, video)),
    named('twitter:title', page.title),
    named('twitter:description', page.description),
    named('twitter:image', image?.url),
    named('twitter:image:alt', image?.alt),
    // The legacy direct-file player tags — the pair Discord actually plays from
    // on a domain that is not on its provider allowlist. Twitter's modern
    // `twitter:player` demands an HTTPS *iframe* URL, which an uploaded .mp4 is
    // not; claiming one we cannot serve gets the card rejected outright,
    // whereas leaving it out degrades cleanly to the poster.
    video ? named('twitter:player:stream', video.url) : '',
    video ? named('twitter:player:stream:content_type', video.type) : '',
    video?.width ? named('twitter:player:width', String(video.width)) : '',
    video?.height ? named('twitter:player:height', String(video.height)) : '',
    ...labelPairs(page.labels),
    jsonLdBlock(page.jsonLd),
  ]
    .filter(Boolean)
    .join('\n');

  const body = [
    `    <h1>${escapeHtml(heading)}</h1>`,
    page.subheading ? `    <p class="sub">${escapeHtml(page.subheading)}</p>` : '',
    mediaBlock(page.media),
    ...(page.paragraphs ?? []).map((text) => `    <p>${escapeHtml(text)}</p>`),
    factList(page.facts),
    ...(page.sections ?? []).map(section),
    `    <p><a href="${canonical}">${escapeHtml(page.siteName)}</a></p>`,
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
${head}
  </head>
  <body>
${body}
  </body>
</html>
`;
}

/** `imageUrl: 'https://…'` and `imageUrl: { url: 'https://…' }` mean the same thing. */
function normaliseImage(input: ShellPage['imageUrl']): ShellImage | null {
  if (!input) return null;
  if (typeof input === 'string') return { url: input };
  return input.url ? input : null;
}

/**
 * `player` needs a poster, or several unfurlers drop the card outright — which
 * would turn a video into NO preview rather than into a still, so a video with
 * no image falls back to the image card it can actually satisfy. `summary` (the
 * small thumbnail) is the honest answer both when there is no image at all —
 * `summary_large_image` with nothing to show renders as a text block under an
 * empty banner — and when the image we have is square, which Discord demotes to
 * a thumbnail regardless of what the tag claims.
 */
function twitterCard(image: ShellImage | null, video: ShellVideo | null): string {
  if (video && image) return 'player';
  if (!image) return 'summary';
  return image.shape === 'square' ? 'summary' : 'summary_large_image';
}

/**
 * Discord's player is sized purely from the declared dimensions, and it refuses
 * anything it reads as too large while rendering anything it reads as tiny at
 * postage-stamp size. Halving a 4K clip and doubling a 360p one is the
 * workaround FxEmbed carries in production for exactly this, and it costs
 * nothing anywhere else: no unfurler uses these numbers to decode, only to lay
 * out. The real file is untouched.
 */
function sizeForDiscord(video: ShellVideo): ShellVideo {
  const { width, height } = video;
  if (!width || !height) return video;
  if (width > 1920 || height > 1920) {
    return { ...video, width: Math.round(width / 2), height: Math.round(height / 2) };
  }
  if (width < 400 && height < 400) {
    return { ...video, width: width * 2, height: height * 2 };
  }
  return video;
}

/** Slack's two labelled fields. Anything past the second pair is dropped by Slack. */
function labelPairs(labels?: { label: string; data: string }[]): string[] {
  return (labels ?? [])
    .slice(0, 2)
    .flatMap((pair, index) => [
      named(`twitter:label${index + 1}`, pair.label),
      named(`twitter:data${index + 1}`, pair.data),
    ]);
}

function imageTags(image: ShellImage | null): string[] {
  if (!image) return [];
  return [
    meta('og:image', image.url),
    // Facebook and several older unfurlers still prefer the explicit secure
    // URL. Only claimed when the URL really is https — asserting it of an http
    // one is a lie the unfurler then acts on.
    image.url.startsWith('https://') ? meta('og:image:secure_url', image.url) : '',
    meta('og:image:type', image.type),
    image.width ? meta('og:image:width', String(image.width)) : '',
    image.height ? meta('og:image:height', String(image.height)) : '',
    meta('og:image:alt', image.alt),
  ].filter(Boolean);
}

function videoTags(video: ShellVideo | null): string[] {
  if (!video) return [];
  return [
    meta('og:video', video.url),
    video.url.startsWith('https://') ? meta('og:video:secure_url', video.url) : '',
    meta('og:video:type', video.type),
    video.width ? meta('og:video:width', String(video.width)) : '',
    video.height ? meta('og:video:height', String(video.height)) : '',
    video.durationSeconds ? meta('video:duration', String(Math.round(video.durationSeconds))) : '',
  ].filter(Boolean);
}

function meta(property: string, content: string | null | undefined): string {
  if (!content) return '';
  return `    <meta property="${property}" content="${escapeHtml(String(content))}" />`;
}

function named(name: string, content: string | null | undefined): string {
  if (!content) return '';
  return `    <meta name="${name}" content="${escapeHtml(String(content))}" />`;
}

/**
 * JSON-LD is data, not code: a `<script type="application/ld+json">` block is
 * not executed, so it is permitted under the site's `script-src 'self'` CSP
 * even though there is no nonce to mint (the build is static). `<` is escaped
 * inside the payload so a member-authored `</script>` cannot break out of the
 * element — the one escape JSON serialisation does not perform for you.
 */
function jsonLdBlock(payload: unknown): string {
  if (!payload) return '';
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `    <script type="application/ld+json">${json}</script>`;
}

function factList(facts?: ShellFact[]): string {
  if (!facts?.length) return '';
  const rows = facts
    .map((fact) => `      <dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`)
    .join('\n');
  return `    <dl>\n${rows}\n    </dl>`;
}

/**
 * The subject of the page, rendered where a reader can actually see it.
 *
 * `preload="none"` on the video is not a nicety: this document is served to
 * crawlers by the hundred, and a shell that pulled the first megabyte of every
 * clip on every unfurl would turn a link preview into a bandwidth bill. The
 * poster is what they get; the bytes move only if a human presses play.
 */
function mediaBlock(media?: ShellMedia | null): string {
  if (!media?.url) return '';
  const dims = [
    media.width ? ` width="${media.width}"` : '',
    media.height ? ` height="${media.height}"` : '',
  ].join('');

  if (media.kind === 'image') {
    // `alt` is always emitted, empty when there is nothing to say — an <img>
    // with no alt attribute at all is an accessibility failure, not a neutral.
    return `    <p><img src="${escapeHtml(media.url)}" alt="${escapeHtml(media.alt ?? '')}"${dims} /></p>`;
  }

  const poster = media.posterUrl ? ` poster="${escapeHtml(media.posterUrl)}"` : '';
  const type = media.type ? ` type="${escapeHtml(media.type)}"` : '';
  return (
    `    <p><video controls preload="none"${poster}${dims}>\n` +
    `      <source src="${escapeHtml(media.url)}"${type} />\n` +
    `    </video></p>`
  );
}

function section(input: { heading: string; links: ShellLink[] }): string {
  if (!input.links.length) return '';
  const items = input.links
    .map((link) => {
      const meta = link.meta ? ` <span>${escapeHtml(link.meta)}</span>` : '';
      // No `rel` attribute at all when the field is absent, rather than an empty
      // one: `rel=""` is legal but it is a claim the previous markup never made,
      // and every existing call site must keep emitting byte-identical HTML.
      const rel = link.rel ? ` rel="${escapeHtml(link.rel)}"` : '';
      return `      <li><a href="${escapeHtml(link.href)}"${rel}>${escapeHtml(link.label)}</a>${meta}</li>`;
    })
    .join('\n');
  return `    <h2>${escapeHtml(input.heading)}</h2>\n    <ul>\n${items}\n    </ul>`;
}
