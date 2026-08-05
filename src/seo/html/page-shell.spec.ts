import { renderPageShell, ShellPage } from './page-shell';

const page: ShellPage = {
  canonicalUrl: 'https://lordsofholdfast.com/u/@panda',
  siteName: 'Lords Regiment',
  title: 'Amitoj (@panda) — Lords Regiment',
  description: 'Colonel in Lords Regiment · 3 decorations · 42 events attended.',
};

describe('renderPageShell', () => {
  it('emits the head a search engine and an unfurler both need', () => {
    const html = renderPageShell({ ...page, imageUrl: 'https://cdn.example/a.png' });

    expect(html).toContain('<title>Amitoj (@panda) — Lords Regiment</title>');
    expect(html).toContain(`<link rel="canonical" href="${page.canonicalUrl}" />`);
    expect(html).toContain(`<meta property="og:url" content="${page.canonicalUrl}" />`);
    expect(html).toContain('<meta property="og:image" content="https://cdn.example/a.png" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('NEVER emits a meta refresh — that is what looped the gallery shell (T-0215)', () => {
    // The predecessor pointed a 0-second refresh at `canonicalUrl`, which is the
    // URL the crawler had just been rewritten FROM. Googlebot follows it as a
    // redirect, re-matches the same UA rule, and loops.
    expect(renderPageShell(page)).not.toContain('http-equiv="refresh"');
  });

  it('renders REAL CONTENT, not a stub — serving a crawler less than a human is cloaking', () => {
    const html = renderPageShell({
      ...page,
      heading: 'Amitoj',
      subheading: 'Colonel · Owner',
      paragraphs: ['Amitoj serves with Lords Regiment at the rank of Colonel.'],
      facts: [
        { label: 'Rank', value: 'Colonel' },
        { label: 'Events attended', value: '42' },
      ],
      sections: [
        {
          heading: 'Honours & Decorations',
          links: [
            {
              href: 'https://lordsofholdfast.com/roster',
              label: 'Valour Cross',
              meta: 'Awarded for conspicuous gallantry.',
            },
          ],
        },
      ],
    });

    expect(html).toContain('<h1>Amitoj</h1>');
    expect(html).toContain('Colonel · Owner');
    expect(html).toContain('serves with Lords Regiment');
    expect(html).toContain('<dt>Rank</dt><dd>Colonel</dd>');
    expect(html).toContain('<h2>Honours &amp; Decorations</h2>');
    // A real crawlable anchor, not a JS row handler — this is the link graph.
    expect(html).toContain('<a href="https://lordsofholdfast.com/roster">Valour Cross</a>');
    expect(html).toContain('Awarded for conspicuous gallantry.');
  });

  it('ESCAPES member-authored text — this is public HTML on the apex domain', () => {
    const html = renderPageShell({
      ...page,
      title: '"><script>alert(1)</script>',
      heading: '"><script>alert(1)</script>',
      facts: [{ label: 'In-game name', value: '<img onerror=alert(1)>' }],
      sections: [
        {
          heading: 'Honours',
          links: [{ href: 'https://x/"><b>', label: '</a><script>x</script>', meta: '<b>' }],
        },
      ],
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<b>');
  });

  it('emits JSON-LD as data, and closes the breakout a member name could open', () => {
    const html = renderPageShell({
      ...page,
      jsonLd: { '@type': 'Person', name: '</script><script>alert(1)</script>' },
    });

    expect(html).toContain('<script type="application/ld+json">');
    // JSON.stringify does not escape `<`, so a member-authored `</script>` would
    // otherwise close the element and execute. Only the ld+json block is ever a
    // <script> in this document.
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  it('honours noindex, for a page that must resolve but must not rank', () => {
    expect(renderPageShell({ ...page, noIndex: true })).toContain(
      '<meta name="robots" content="noindex, follow" />',
    );
    expect(renderPageShell(page)).not.toContain('name="robots"');
  });

  it('emits rel=prev/next only where a paginated list has them', () => {
    const html = renderPageShell({
      ...page,
      prevUrl: 'https://lordsofholdfast.com/roster',
      nextUrl: 'https://lordsofholdfast.com/roster?page=3',
    });

    expect(html).toContain('<link rel="prev" href="https://lordsofholdfast.com/roster" />');
    expect(html).toContain('<link rel="next" href="https://lordsofholdfast.com/roster?page=3" />');
    expect(renderPageShell(page)).not.toContain('rel="prev"');
  });

  it('omits an empty section rather than rendering a bare heading', () => {
    const html = renderPageShell({ ...page, sections: [{ heading: 'Honours', links: [] }] });

    expect(html).not.toContain('<h2>Honours</h2>');
  });

  it('emits rel on a link that asks for one, and NOTHING on one that does not (T-0216)', () => {
    const html = renderPageShell({
      ...page,
      sections: [
        {
          heading: 'Elsewhere',
          links: [
            { href: 'https://www.twitch.tv/panda', label: 'Twitch — panda', rel: 'nofollow ugc' },
            { href: 'https://lordsofholdfast.com/roster', label: 'Regimental Roster' },
          ],
        },
      ],
    });

    expect(html).toContain(
      '<a href="https://www.twitch.tv/panda" rel="nofollow ugc">Twitch — panda</a>',
    );
    // Every pre-existing call site passes no `rel`, and must keep emitting the
    // exact markup it emitted before — an empty rel="" is a claim, not a no-op.
    expect(html).toContain('<a href="https://lordsofholdfast.com/roster">Regimental Roster</a>');
    expect(html).not.toContain('rel=""');
  });

  it('escapes rel like every other interpolated value', () => {
    const html = renderPageShell({
      ...page,
      sections: [
        {
          heading: 'Elsewhere',
          links: [{ href: 'https://x/', label: 'X', rel: '" onmouseover="alert(1)' }],
        },
      ],
    });

    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('rel="&quot; onmouseover=&quot;alert(1)"');
  });
});
