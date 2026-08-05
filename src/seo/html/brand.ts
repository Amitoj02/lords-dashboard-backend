/**
 * Brand constants that reach a link preview (T-0293).
 *
 * ── WHY A CONSTANT AND NOT `regiment.accentTone` ────────────────────────────
 * `RegimentProfileDto.accentTone` exists and is a free-text column, but nothing
 * has ever set it to anything but `'brass'` and the frontend does not switch on
 * it — there is no tone→hex table anywhere in either repo to read. Deriving the
 * embed colour from a field with one value and no mapping would be indirection
 * pretending to be configuration. When a second tone genuinely ships, this is
 * the one place that has to learn about it.
 */

/**
 * `--brass-400` from the frontend's `_variables.scss`, the colour the site's
 * rules, crest and headings are drawn in.
 *
 * Discord paints the left edge of an embed with the page's `theme-color`, so
 * this is the single byte of branding every shared link carries. It is
 * deliberately NOT `--ink-900` (`#0b0e14`, the `theme-color` in `index.html`):
 * that value exists to tint the mobile browser chrome to match the page
 * background, and as an embed stripe it is indistinguishable from Discord's own
 * default grey — i.e. from having set nothing at all.
 */
export const BRAND_ACCENT = '#c69a45';

/**
 * `"<page> | <Regiment>"` — the document title, on both surfaces (T-0293).
 *
 * ── WHY THIS IS SHARED CODE AND NOT A STRING TEMPLATE PER CALL SITE ─────────
 * The frontend's `SeoService.apply()` builds `<title>` and `og:title` with
 * exactly this rule, including the `includes()` guard that stops a page which
 * already names the regiment from naming it twice. The shells used to write
 * `"<page> — <Regiment>"` with an em dash instead, so every URL under the
 * crawler matcher had two different titles depending on which of the two
 * documents a client received — the precise disagreement dynamic rendering is
 * not allowed to have, sitting in the single most visible string on the page.
 *
 * If the frontend rule ever changes, this has to change in the same deploy.
 */
export function documentTitle(pageTitle: string, siteName: string): string {
  return pageTitle.includes(siteName) ? pageTitle : `${pageTitle} | ${siteName}`;
}
