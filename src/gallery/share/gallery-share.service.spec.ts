import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { GalleryMediaType, GalleryStatus, GalleryType } from '../../common/enums';
import { GalleryItemDto } from '../dto/gallery-item.dto';
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
  const gallery = { findOnePublic: jest.fn() };

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GalleryShareService,
        { provide: GalleryService, useValue: gallery },
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

  it('falls back to a generic site card', () => {
    expect(service.renderFallback()).toContain(
      '<meta property="og:title" content="Lords Regiment" />',
    );
  });
});
