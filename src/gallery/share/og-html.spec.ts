import { escapeHtml, renderOpenGraphShell } from './og-html';

/**
 * T-0197. This module's whole job is to emit bytes a crawler reads, on a public
 * route, containing member-authored text — so the tests that matter are about
 * ESCAPING and about the tags actually being present, not about prettiness.
 */
describe('renderOpenGraphShell', () => {
  const card = {
    canonicalUrl: 'https://lords.example/gallery/abc123XYZ456',
    siteName: 'Lords Regiment',
    title: 'The charge at dawn',
    description: 'Third company, second line.',
  };

  it('emits the tags an unfurler actually reads', () => {
    const html = renderOpenGraphShell({ ...card, imageUrl: 'https://cdn.example/a.png' });

    expect(html).toContain('<meta property="og:title" content="The charge at dawn" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://lords.example/gallery/abc123XYZ456" />',
    );
    expect(html).toContain('<meta property="og:image" content="https://cdn.example/a.png" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('bounces a HUMAN to the SPA without a script', () => {
    // The site CSP is `script-src 'self'` with no nonce — a statically-served
    // build has nothing to mint one with — so an inline redirect script would be
    // blocked outright. Meta refresh plus a real anchor is the whole fallback.
    const html = renderOpenGraphShell(card);

    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${card.canonicalUrl}" />`);
    expect(html).toContain(`<a href="${card.canonicalUrl}">`);
    expect(html).not.toContain('<script');
  });

  it('ESCAPES a member-authored title — this is public HTML on the apex domain', () => {
    const html = renderOpenGraphShell({
      ...card,
      title: '"><script>alert(1)</script>',
      description: "O'Brien & co <b>",
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('O&#39;Brien &amp; co &lt;b&gt;');
  });

  it('marks an uploaded clip as a playable video', () => {
    const html = renderOpenGraphShell({
      ...card,
      imageUrl: 'https://cdn.example/poster.png',
      video: { url: 'https://cdn.example/clip.mp4', type: 'video/mp4', width: 1920, height: 1080 },
    });

    expect(html).toContain('<meta property="og:type" content="video.other" />');
    expect(html).toContain('<meta property="og:video" content="https://cdn.example/clip.mp4" />');
    expect(html).toContain('<meta property="og:video:type" content="video/mp4" />');
    expect(html).toContain('<meta name="twitter:card" content="player" />');
  });

  it('never claims a PLAYER card without a poster', () => {
    // Twitter and several other unfurlers drop a player card that has no image,
    // which would degrade a video from "a still" to "no preview at all".
    const html = renderOpenGraphShell({
      ...card,
      imageUrl: null,
      video: { url: 'https://cdn.example/clip.mp4', type: 'video/mp4' },
    });

    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('omits a tag entirely rather than emitting an empty one', () => {
    const html = renderOpenGraphShell({ ...card, imageUrl: null, description: '' });

    expect(html).not.toContain('og:image');
    expect(html).not.toContain('og:description');
  });
});

describe('escapeHtml', () => {
  it('uses the numeric entity for an apostrophe, not &apos;', () => {
    // `&apos;` is undefined in HTML 4 and some older unfurlers still parse as
    // such, which would render the raw entity text inside a card title.
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes the ampersand FIRST, so entities are not double-encoded wrongly', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
