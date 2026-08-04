import { escapeHtml } from '../../gallery/share/og-html';

/** One `<a>` in a rendered list. */
export interface ShellLink {
  href: string;
  label: string;
  /** Optional muted second line (rank, date, caption…). */
  meta?: string | null;
}

/** A `<dt>/<dd>` pair in the facts list. */
export interface ShellFact {
  label: string;
  value: string;
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
  imageUrl?: string | null;
  ogType?: 'website' | 'profile' | 'article';
  /** Tell search engines not to index this page (suspended member, paginated tail…). */
  noIndex?: boolean;
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
 * The crawler-facing HTML for a public page (T-0215).
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

  const head = [
    `    <title>${escapeHtml(page.title)}</title>`,
    named('description', page.description),
    `    <link rel="canonical" href="${canonical}" />`,
    page.noIndex ? '    <meta name="robots" content="noindex, follow" />' : '',
    page.prevUrl ? `    <link rel="prev" href="${escapeHtml(page.prevUrl)}" />` : '',
    page.nextUrl ? `    <link rel="next" href="${escapeHtml(page.nextUrl)}" />` : '',
    meta('og:site_name', page.siteName),
    meta('og:type', page.ogType ?? 'website'),
    meta('og:url', page.canonicalUrl),
    meta('og:title', page.title),
    meta('og:description', page.description),
    meta('og:image', page.imageUrl),
    named('twitter:card', page.imageUrl ? 'summary_large_image' : 'summary'),
    named('twitter:title', page.title),
    named('twitter:description', page.description),
    named('twitter:image', page.imageUrl),
    jsonLdBlock(page.jsonLd),
  ]
    .filter(Boolean)
    .join('\n');

  const body = [
    `    <h1>${escapeHtml(heading)}</h1>`,
    page.subheading ? `    <p class="sub">${escapeHtml(page.subheading)}</p>` : '',
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

function section(input: { heading: string; links: ShellLink[] }): string {
  if (!input.links.length) return '';
  const items = input.links
    .map((link) => {
      const meta = link.meta ? ` <span>${escapeHtml(link.meta)}</span>` : '';
      return `      <li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>${meta}</li>`;
    })
    .join('\n');
  return `    <h2>${escapeHtml(input.heading)}</h2>\n    <ul>\n${items}\n    </ul>`;
}
