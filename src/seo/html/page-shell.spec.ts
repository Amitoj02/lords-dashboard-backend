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
    expect(renderPageShell({ ...page, noIndex: true })).not.toContain('max-image-preview');
  });

  it('opts an indexable page into the LARGE image preview — the default is a thumbnail', () => {
    expect(renderPageShell(page)).toContain(
      '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />',
    );
  });

  describe('the unfurler half of the document (T-0293)', () => {
    it('colours the Discord embed stripe from theme-color', () => {
      expect(renderPageShell({ ...page, themeColor: '#c69a45' })).toContain(
        '<meta name="theme-color" content="#c69a45" />',
      );
    });

    it('declares the image dimensions an unfurler lays the card out from', () => {
      const html = renderPageShell({
        ...page,
        imageUrl: { url: 'https://cdn.example/a.png', width: 1200, height: 630, alt: 'A banner' },
      });

      expect(html).toContain('<meta property="og:image:width" content="1200" />');
      expect(html).toContain('<meta property="og:image:height" content="630" />');
      expect(html).toContain('<meta property="og:image:alt" content="A banner" />');
      expect(html).toContain(
        '<meta property="og:image:secure_url" content="https://cdn.example/a.png" />',
      );
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    });

    it('asks for the SMALL card when the only image is square', () => {
      // Discord inspects the real file and demotes a square image to a thumbnail
      // whatever the tag claims, so a profile with only an avatar asks for the
      // layout it can actually fill instead of one that will look broken.
      const html = renderPageShell({
        ...page,
        imageUrl: { url: 'https://cdn.example/avatar.png', shape: 'square' },
      });

      expect(html).toContain('<meta name="twitter:card" content="summary" />');
    });

    it('does not claim og:image:secure_url of an http url', () => {
      expect(renderPageShell({ ...page, imageUrl: 'http://cdn.example/a.png' })).not.toContain(
        'og:image:secure_url',
      );
    });

    it('emits the full tag set that makes an mp4 play inline in Discord', () => {
      const html = renderPageShell({
        ...page,
        ogType: 'video.other',
        imageUrl: 'https://cdn.example/poster.png',
        video: {
          url: 'https://cdn.example/clip.mp4',
          type: 'video/mp4',
          width: 1280,
          height: 720,
          durationSeconds: 95,
        },
      });

      expect(html).toContain('<meta property="og:type" content="video.other" />');
      expect(html).toContain('<meta property="og:video" content="https://cdn.example/clip.mp4" />');
      expect(html).toContain(
        '<meta property="og:video:secure_url" content="https://cdn.example/clip.mp4" />',
      );
      expect(html).toContain('<meta property="og:video:type" content="video/mp4" />');
      expect(html).toContain('<meta property="og:video:width" content="1280" />');
      expect(html).toContain('<meta property="og:video:height" content="720" />');
      expect(html).toContain('<meta property="video:duration" content="95" />');
      expect(html).toContain(
        '<meta name="twitter:player:stream" content="https://cdn.example/clip.mp4" />',
      );
      expect(html).toContain(
        '<meta name="twitter:player:stream:content_type" content="video/mp4" />',
      );
      expect(html).toContain('<meta name="twitter:player:width" content="1280" />');
      // player, not summary_large_image — and only because there IS a poster.
      expect(html).toContain('<meta name="twitter:card" content="player" />');
    });

    it('falls back to the image card for a video with no poster', () => {
      // Several unfurlers drop a player card that has no still, which would turn
      // a video into no preview at all rather than into a frame of itself.
      const html = renderPageShell({
        ...page,
        video: { url: 'https://cdn.example/clip.mp4', type: 'video/mp4' },
      });

      expect(html).toContain('<meta name="twitter:card" content="summary" />');
    });

    it('halves a 4K clip and doubles a tiny one, because Discord sizes from the tags', () => {
      const huge = renderPageShell({
        ...page,
        imageUrl: 'https://cdn.example/p.png',
        video: { url: 'https://cdn.example/c.mp4', type: 'video/mp4', width: 3840, height: 2160 },
      });
      const tiny = renderPageShell({
        ...page,
        imageUrl: 'https://cdn.example/p.png',
        video: { url: 'https://cdn.example/c.mp4', type: 'video/mp4', width: 320, height: 240 },
      });

      expect(huge).toContain('<meta property="og:video:width" content="1920" />');
      expect(huge).toContain('<meta property="og:video:height" content="1080" />');
      expect(tiny).toContain('<meta property="og:video:width" content="640" />');
      expect(tiny).toContain('<meta property="og:video:height" content="480" />');
    });

    it('renders the subject in the BODY too, not only in the head', () => {
      const image = renderPageShell({
        ...page,
        media: { kind: 'image', url: 'https://cdn.example/a.png', alt: 'The charge', width: 1920 },
      });
      const video = renderPageShell({
        ...page,
        media: {
          kind: 'video',
          url: 'https://cdn.example/c.mp4',
          posterUrl: 'https://cdn.example/p.png',
          type: 'video/mp4',
        },
      });

      expect(image).toContain(
        '<img src="https://cdn.example/a.png" alt="The charge" width="1920" />',
      );
      // preload="none": this document is fetched by crawlers in bulk, and a shell
      // that pulled every clip's first megabyte per unfurl is a bandwidth bill.
      expect(video).toContain('<video controls preload="none" poster="https://cdn.example/p.png">');
      expect(video).toContain('<source src="https://cdn.example/c.mp4" type="video/mp4" />');
    });

    it('emits an empty alt rather than no alt attribute', () => {
      expect(
        renderPageShell({ ...page, media: { kind: 'image', url: 'https://cdn.example/a.png' } }),
      ).toContain('alt=""');
    });

    it('gives Slack two labelled fields and drops the rest', () => {
      const html = renderPageShell({
        ...page,
        labels: [
          { label: 'Rank', data: 'Colonel' },
          { label: 'Decorations', data: '3' },
          { label: 'Ignored', data: 'yes' },
        ],
      });

      expect(html).toContain('<meta name="twitter:label1" content="Rank" />');
      expect(html).toContain('<meta name="twitter:data2" content="3" />');
      expect(html).not.toContain('Ignored');
    });
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
