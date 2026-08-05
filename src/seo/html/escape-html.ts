/**
 * HTML escaping for the server-rendered crawler shells (T-0293).
 *
 * ── WHY IT LIVES HERE AND NOT IN `gallery/share` ────────────────────────────
 * It used to be exported from `gallery/share/og-html.ts`, which meant the SEO
 * module — the general renderer for every public page — reached sideways into
 * one feature's share code for its single most safety-critical primitive. That
 * import direction was backwards, and it became untenable once the gallery card
 * started rendering through `page-shell.ts` instead of the other way round.
 *
 * Applied to EVERY interpolated value without exception. Member-authored text
 * (in-game names, handles, bios, gallery titles and captions, event titles and
 * descriptions) reaches these documents, and they are served from the site's own
 * origin — an unescaped `"` closing a content attribute is stored XSS on the
 * apex domain, and an unescaped `<` closing an element is worse.
 *
 * `'` becomes the numeric `&#39;` rather than `&apos;`: the named form is not
 * defined in HTML 4, and some older unfurlers still parse as such.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
