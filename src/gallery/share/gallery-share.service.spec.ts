import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { GalleryMediaType, GalleryStatus, GalleryType } from '../../common/enums';
import { GalleryItemDto } from '../dto/gallery-item.dto';
import { RegimentsService } from '../../regiments/regiments.service';
import { GalleryService } from '../gallery.service';
import { GalleryShareService } from './gallery-share.service';

const SITE = 'https://lords.example';

/**
 * T-0197. What a pasted share link turns into in Discord/WhatsApp/Slack.
 *
 * The rule under test is per media KIND, and the interesting cases are the ones
 * where the honest answer is a poorer card: an unrecognised external host gets
 * metadata and nothing fetched, because the alternative is an unauthenticated
 * route that pulls arbitrary member-supplied URLs server-side and republishes
 * whatever comes back.
 */
describe('GalleryShareService', () => {
  let service: GalleryShareService;
  const gallery = { findOnePublic: jest.fn(), findPublic: jest.fn() };
  // The regiment's own name, which the shell used to hardcode (T-0293).
  const regiments = { getProfile: jest.fn() };

  const item = (overrides: Partial<GalleryItemDto> = {}): GalleryItemDto => ({
    id: 'abc123XYZ456',
    title: 'The charge at dawn',
    caption: null,
    type: GalleryType.Image,
    linkUrl: null,
    thumbnailUrl: null,
    status: GalleryStatus.Approved,
    declineReason: null,
    author: { memberId: 'm1', name: 'Jane', avatarUrl: null },
    files: [],
    tags: [],
    likesCount: 0,
    viewsCount: 0,
    submittedAt: '2026-07-01T10:00:00.000Z',
    approvedAt: null,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...overrides,
  });

  const file = (over: Record<string, unknown> = {}) =>
    ({
      id: 'f1',
      fileName: 'a.png',
      url: 'https://cdn.example/a.png',
      mediaType: GalleryMediaType.Image,
      sizeBytes: null,
      width: null,
      height: null,
      durationSeconds: null,
      caption: null,
      thumbnailColor: null,
      ...over,
    }) as GalleryItemDto['files'][number];

  beforeEach(async () => {
    jest.clearAllMocks();
    regiments.getProfile.mockResolvedValue({ name: 'Lords Regiment' });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GalleryShareService,
        { provide: GalleryService, useValue: gallery },
        { provide: RegimentsService, useValue: regiments },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === 'frontend' ? { url: SITE } : 'api')),
          },
        },
      ],
    }).compile();
    service = module.get(GalleryShareService);
  });

  it('points og:url at the SPA route, not at itself', async () => {
    gallery.findOnePublic.mockResolvedValue(item());

    const html = (await service.renderItem('abc123XYZ456')) as string;

    expect(html).toContain(`<meta property="og:url" content="${SITE}/gallery/abc123XYZ456" />`);
  });

  it('shows an uploaded image', async () => {
    gallery.findOnePublic.mockResolvedValue(item({ files: [file()] }));

    const html = (await service.renderItem('abc123XYZ456')) as string;

    expect(html).toContain('<meta property="og:image" content="https://cdn.example/a.png" />');
  });

  it('makes an uploaded video PLAYABLE, with its poster as the still', async () => {
    gallery.findOnePublic.mockResolvedValue(
      item({
        type: GalleryType.Video,
        thumbnailUrl: 'https://cdn.example/poster.png',
        files: [
          file({
            url: 'https://cdn.example/clip.mp4',
            mediaType: GalleryMediaType.Video,
            width: 1920,
            height: 1080,
          }),
        ],
      }),
    );

    const html = (await service.renderItem('abc123XYZ456')) as string;

    expect(html).toContain('<meta property="og:video" content="https://cdn.example/clip.mp4" />');
    expect(html).toContain('<meta property="og:video:type" content="video/mp4" />');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example/poster.png" />');
    expect(html).toContain('<meta name="twitter:card" content="player" />');
  });

  it('reports a .webm by its real container', async () => {
    gallery.findOnePublic.mockResolvedValue(
      item({
        type: GalleryType.Video,
        thumbnailUrl: 'https://cdn.example/p.png',
        files: [file({ url: 'https://cdn.example/clip.webm', mediaType: GalleryMediaType.Video })],
      }),
    );

    expect((await service.renderItem('abc123XYZ456')) as string).toContain(
      '<meta property="og:video:type" content="video/webm" />',
    );
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
  ])('recognises the YouTube URL %s', async (linkUrl) => {
    // *** THE `www.` CASE IS WHY THIS IS PARAMETERISED. *** The extractors match
    // the bare `youtube.com`, so a caller passing `parsed.hostname` straight
    // through silently missed every `www.` URL — which is exactly the form
    // YouTube's own share button produces. It shipped broken until a live check
    // caught it.
    gallery.findOnePublic.mockResolvedValue(item({ type: GalleryType.Link, linkUrl }));

    const html = (await service.renderItem('abc123XYZ456')) as string;

    expect(html).toContain(
      '<meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" />',
    );
    expect(html).toContain(
      '<meta property="og:video" content="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" />',
    );
  });

  it('uses the same-origin proxy for a Medal clip, not Medal’s expiring CDN url', async () => {
    gallery.findOnePublic.mockResolvedValue(
      item({ type: GalleryType.Link, linkUrl: 'https://medal.tv/clips/abcXYZ' }),
    );

    const html = (await service.renderItem('abc123XYZ456')) as string;

    expect(html).toContain(
      `<meta property="og:image" content="${SITE}/api/gallery/media/medal/abcXYZ/thumbnail" />`,
    );
  });

  it('gives an UNRECOGNISED host metadata only — nothing is fetched from it', async () => {
    gallery.findOnePublic.mockResolvedValue(
      item({ type: GalleryType.Link, linkUrl: 'https://sketchy.example/thing?a=1' }),
    );

    const html = (await service.renderItem('abc123XYZ456')) as string;

    expect(html).toContain('https://sketchy.example');
    // No image, no player: the server never went and looked.
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('og:video');
  });

  it('returns null for an item that is not publicly visible', async () => {
    // NotFound and Forbidden (a private gallery) are one answer to a crawler.
    gallery.findOnePublic.mockRejectedValue(new NotFoundException());

    expect(await service.renderItem('abc123XYZ456')).toBeNull();
  });

  it('falls back to a generic site card that must not be indexed', async () => {
    const html = await service.renderFallback();

    // Every dead id would otherwise look like one page duplicated across the
    // whole /gallery/* space.
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
    expect(html).toContain('<meta property="og:title" content="Gallery | Lords Regiment" />');
  });

  /**
   * T-0293. The half of the document that is NOT for an unfurler.
   *
   * The same Caddy matcher that sends Discord here sends Googlebot here, and the
   * shell this replaced had a one-anchor body. A search engine given a stub
   * while every human gets a populated Angular page is cloaking whatever the
   * intent was — so these assert that the page a crawler reads says what the
   * page a human reads says.
   */
  describe('the crawlable half of the document (T-0293)', () => {
    it('puts the picture, the author and the tags in the BODY', async () => {
      gallery.findOnePublic.mockResolvedValue(
        item({ files: [file({ width: 1920, height: 1080 })], tags: ['clutch', 'line-battle'] }),
      );

      const html = (await service.renderItem('abc123XYZ456')) as string;

      expect(html).toContain('<h1>The charge at dawn</h1>');
      expect(html).toContain('<p class="sub">Submitted by Jane</p>');
      expect(html).toContain('<img src="https://cdn.example/a.png"');
      expect(html).toContain('<dt>Submitted by</dt><dd>Jane</dd>');
      expect(html).toContain('<dt>Tags</dt><dd>clutch, line-battle</dd>');
    });

    it('claims ImageObject with the credit Google requires alongside contentUrl', async () => {
      gallery.findOnePublic.mockResolvedValue(item({ files: [file()] }));

      const ld = jsonLd((await service.renderItem('abc123XYZ456')) as string);

      expect(ld['@type']).toBe('ImageObject');
      expect(ld.contentUrl).toBe('https://cdn.example/a.png');
      // contentUrl alone is not enough — at least one of creator/creditText/
      // copyrightNotice/license has to be there or the item is invalid.
      expect(ld.creditText).toBe('Jane · Lords Regiment');
      expect(ld.copyrightNotice).toBe('© Lords Regiment');
    });

    it('claims VideoObject only when there is a poster AND an upload date', async () => {
      gallery.findOnePublic.mockResolvedValue(
        item({
          type: GalleryType.Video,
          thumbnailUrl: 'https://cdn.example/poster.png',
          approvedAt: '2026-07-02T09:00:00.000Z',
          files: [
            file({
              url: 'https://cdn.example/clip.mp4',
              mediaType: GalleryMediaType.Video,
              durationSeconds: 95,
            }),
          ],
        }),
      );

      const ld = jsonLd((await service.renderItem('abc123XYZ456')) as string);

      expect(ld['@type']).toBe('VideoObject');
      expect(ld.thumbnailUrl).toBe('https://cdn.example/poster.png');
      expect(ld.uploadDate).toBe('2026-07-02T09:00:00.000Z');
      expect(ld.contentUrl).toBe('https://cdn.example/clip.mp4');
      expect(ld.duration).toBe('PT1M35S');
    });

    it('degrades to CreativeWork rather than an INVALID VideoObject with no poster', async () => {
      // thumbnailUrl and uploadDate are both required. A VideoObject missing one
      // is a structured-data error, which is worse than not claiming the type.
      gallery.findOnePublic.mockResolvedValue(
        item({
          type: GalleryType.Video,
          thumbnailUrl: null,
          files: [file({ url: 'https://cdn.example/clip.mp4', mediaType: GalleryMediaType.Video })],
        }),
      );

      expect(jsonLd((await service.renderItem('abc123XYZ456')) as string)['@type']).toBe(
        'CreativeWork',
      );
    });

    it('names the external host as a nofollow ugc link, never as an embed', async () => {
      gallery.findOnePublic.mockResolvedValue(
        item({ type: GalleryType.Link, linkUrl: 'https://sketchy.example/thing' }),
      );

      const html = (await service.renderItem('abc123XYZ456')) as string;

      expect(html).toContain(
        '<a href="https://sketchy.example/thing" rel="nofollow ugc">https://sketchy.example</a>',
      );
      expect(html).not.toContain('<iframe');
    });

    it('renders the index as a linked list with an ImageGallery payload', async () => {
      gallery.findPublic.mockResolvedValue({
        data: [item({ id: 'aaa111BBB222', files: [file()] })],
        meta: { page: 1, limit: 24, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
      });

      const html = await service.renderIndex(1);
      const ld = jsonLd(html);

      expect(html).toContain(`<a href="${SITE}/gallery/aaa111BBB222">The charge at dawn</a>`);
      expect(html).toContain('<meta property="og:title" content="Gallery | Lords Regiment" />');
      // The newest usable still becomes the card for the gallery itself.
      expect(html).toContain('<meta property="og:image" content="https://cdn.example/a.png" />');
      expect(ld['@type']).toBe('ImageGallery');
      expect(ld.numberOfItems).toBe(1);
    });

    it('paginates with rel=prev/next and a page-specific canonical', async () => {
      gallery.findPublic.mockResolvedValue({
        data: [],
        meta: { page: 2, limit: 24, total: 40, totalPages: 2, hasNext: false, hasPrev: true },
      });

      const html = await service.renderIndex(2);

      expect(html).toContain(`<link rel="canonical" href="${SITE}/gallery?page=2" />`);
      expect(html).toContain(`<link rel="prev" href="${SITE}/gallery" />`);
      expect(html).not.toContain('rel="next"');
    });
  });
});

/** The one ld+json block, parsed back out of the rendered document. */
function jsonLd(html: string): Record<string, unknown> {
  const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (!match) throw new Error('no ld+json block in the rendered shell');
  return JSON.parse(match[1].replace(/\\u003c/g, '<')) as Record<string, unknown>;
}
