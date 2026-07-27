/**
 * The crawler-facing HTML shell for a gallery share link (T-0197).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The SPA is a purely client-side Angular build served as static files, and no
 * unfurler — Discord, WhatsApp, Slack, Twitter, iMessage — runs JavaScript. So
 * `Meta.updateTag()` in a component cannot produce a link preview no matter how
 * correct it is; the tags have to be in the bytes the server returns. This
 * module IS those bytes.
 *
 * ── WHY A TEMPLATE STRING AND NOT AN .html FILE ─────────────────────────────
 * `nest-cli.json` declares no `compilerOptions.assets`, so non-`.ts` files under
 * `src/` are never copied into `dist/`, and the production image only ships
 * `dist/`. An `.html` template would work locally and 500 in the container.
 */

/** Everything the shell renders, already resolved by the caller. */
export interface OpenGraphCard {
  /** Canonical SPA URL — where a human is sent and what `og:url` claims. */
  canonicalUrl: string;
  siteName: string;
  title: string;
  description: string;
  /** A still. Permanent, absolute, and public — never a signed URL. */
  imageUrl?: string | null;
  /**
   * A playable video. `mp4`/`webm` for an uploaded file (Discord plays it from
   * the URL directly); `text/html` for an external embed page.
   */
  video?: { url: string; type: string; width?: number | null; height?: number | null } | null;
}

/**
 * HTML-escape. Applied to EVERY interpolated value without exception —
 * `title`, `caption` and `linkUrl` are member-authored free text, and this
 * document is served from the site's own origin, so an unescaped `"` closing a
 * content attribute would be stored XSS on the apex domain.
 *
 * `'` is escaped as the numeric `&#39;` rather than `&apos;` because the latter
 * is not defined in HTML 4 and some older unfurlers still parse as such.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One `<meta property="…" content="…">`, or nothing when the value is empty. */
function meta(property: string, content: string | null | undefined): string {
  if (content === null || content === undefined || content === '') return '';
  return `    <meta property="${property}" content="${escapeHtml(String(content))}" />\n`;
}

/** Same, for the `name=` flavour Twitter/X and Slack read. */
function named(name: string, content: string | null | undefined): string {
  if (content === null || content === undefined || content === '') return '';
  return `    <meta name="${name}" content="${escapeHtml(String(content))}" />\n`;
}

/**
 * Render the shell.
 *
 * The card is `player` when there is a video and `summary_large_image`
 * otherwise — and NEVER `player` without an image, because Twitter and several
 * other unfurlers drop a player card that has no poster, which would degrade a
 * video to no preview at all rather than to a still.
 *
 * A human who opens this URL is bounced to the SPA by `<meta http-equiv=
 * "refresh">`. Not a script: the site CSP is `script-src 'self'` with no nonce
 * (a statically-served build has nothing to mint one with), so an inline script
 * would be blocked. The visible anchor is the last resort for a client that
 * honours neither.
 */
export function renderOpenGraphShell(card: OpenGraphCard): string {
  const canonical = escapeHtml(card.canonicalUrl);
  const twitterCard = card.video && card.imageUrl ? 'player' : 'summary_large_image';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(card.title)}</title>
${named('description', card.description)}    <link rel="canonical" href="${canonical}" />
    <meta http-equiv="refresh" content="0; url=${canonical}" />
${meta('og:site_name', card.siteName)}${meta('og:type', card.video ? 'video.other' : 'article')}${meta('og:url', card.canonicalUrl)}${meta('og:title', card.title)}${meta('og:description', card.description)}${meta('og:image', card.imageUrl)}${card.video ? meta('og:video', card.video.url) : ''}${card.video ? meta('og:video:secure_url', card.video.url) : ''}${card.video ? meta('og:video:type', card.video.type) : ''}${card.video?.width ? meta('og:video:width', String(card.video.width)) : ''}${card.video?.height ? meta('og:video:height', String(card.video.height)) : ''}${named('twitter:card', twitterCard)}${named('twitter:title', card.title)}${named('twitter:description', card.description)}${named('twitter:image', card.imageUrl)}${card.video ? named('twitter:player:stream', card.video.url) : ''}  </head>
  <body>
    <p><a href="${canonical}">${escapeHtml(card.title)}</a></p>
  </body>
</html>
`;
}
