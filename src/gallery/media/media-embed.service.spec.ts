import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { MediaProvider } from '../../common/enums';
import { MediaEmbedService } from './media-embed.service';

type FetchImpl = (url: string) => Promise<unknown>;

const makeService = (youtubeApiKey = ''): MediaEmbedService => {
  const config = {
    get: (section: string) =>
      section === 'integrations' ? { youtubeApiKey } : section === 'apiPrefix' ? 'api' : undefined,
  } as unknown as ConfigService<AppConfig, true>;
  return new MediaEmbedService(config);
};

const htmlResponse = (html: string, url = 'https://medal.tv/clip/abc123') => ({
  ok: true,
  url,
  text: () => Promise.resolve(html),
});
/** A minimal Response stub with a single-chunk readable body (for the bounded read). */
const imageResponse = (
  contentType = 'image/jpeg',
  url = 'https://cdn.medal.tv/clip/abc.png',
  bytes = new Uint8Array([1, 2, 3]),
  contentLength: string | null = null,
) => ({
  ok: true,
  url,
  headers: {
    get: (h: string) => {
      const k = h.toLowerCase();
      if (k === 'content-type') return contentType;
      if (k === 'content-length') return contentLength;
      return null;
    },
  },
  body: {
    getReader: () => {
      let sent = false;
      return {
        read: () =>
          sent
            ? Promise.resolve({ done: true, value: undefined })
            : ((sent = true), Promise.resolve({ done: false, value: bytes })),
        cancel: () => Promise.resolve(),
      };
    },
  },
});

describe('MediaEmbedService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('extractYouTubeId', () => {
    const cases: [string, string | null][] = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/watch?v=short', null],
      ['https://example.com/watch?v=dQw4w9WgXcQ', null],
    ];
    it.each(cases)('%s → %s', (url, expected) => {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      expect(MediaEmbedService.extractYouTubeId(parsed, host)).toBe(expected);
    });
  });

  describe('extractMedalId', () => {
    const cases: [string, string | null][] = [
      ['https://medal.tv/clips/abc123', 'abc123'],
      ['https://medal.tv/clip/abc123', 'abc123'],
      ['https://medal.tv/clip/abc123/deadbeef', 'abc123'],
      ['https://medal.tv/games/holdfast/clips/xyz789', 'xyz789'],
      ['https://medal.tv/?contentId=zzz111', 'zzz111'],
      ['https://not-medal.tv/clips/abc123', null],
      ['https://example.com/clips/abc123', null],
    ];
    it.each(cases)('%s → %s', (url, expected) => {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      expect(MediaEmbedService.extractMedalId(parsed, host)).toBe(expected);
    });
  });

  describe('parseIso8601Duration', () => {
    it('parses hours/minutes/seconds', () => {
      expect(MediaEmbedService.parseIso8601Duration('PT1M30S')).toBe(90);
      expect(MediaEmbedService.parseIso8601Duration('PT1H2M3S')).toBe(3723);
      expect(MediaEmbedService.parseIso8601Duration('PT45S')).toBe(45);
      expect(MediaEmbedService.parseIso8601Duration(undefined)).toBeNull();
      expect(MediaEmbedService.parseIso8601Duration('nonsense')).toBeNull();
    });
  });

  describe('resolve', () => {
    it('resolves a YouTube URL to a nocookie embed + i.ytimg poster (no key → no enrichment)', async () => {
      const service = makeService('');
      const result = await service.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(result.provider).toBe(MediaProvider.YouTube);
      expect(result.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
      expect(result.thumbnailUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
      expect(result.title).toBeNull();
      expect(result.durationSeconds).toBeNull();
    });

    it('resolves a Medal.tv URL to a clip embed + stable proxy thumbnail', async () => {
      const service = makeService();
      const result = await service.resolve('https://medal.tv/clips/abc123/xyz');
      expect(result.provider).toBe(MediaProvider.MedalTv);
      expect(result.embedUrl).toBe('https://medal.tv/clip/abc123');
      expect(result.thumbnailUrl).toBe('/api/gallery/media/medal/abc123/thumbnail');
    });

    it('detects direct image + video URLs and falls back to link', async () => {
      const service = makeService();
      expect((await service.resolve('https://cdn.example/a.png')).provider).toBe(
        MediaProvider.Image,
      );
      expect((await service.resolve('https://cdn.example/a.mp4')).provider).toBe(
        MediaProvider.Video,
      );
      expect((await service.resolve('https://example.com/some/page')).provider).toBe(
        MediaProvider.Link,
      );
      expect((await service.resolve('not a url')).provider).toBe(MediaProvider.Link);
    });
  });

  describe('getMedalThumbnail', () => {
    it('scrapes the og:image and returns the cached bytes, re-serving without re-fetching', async () => {
      const service = makeService();
      const fetchMock = jest.fn<Promise<unknown>, [string]>(((url: string) =>
        url.includes('cdn.medal.tv')
          ? Promise.resolve(imageResponse('image/png'))
          : Promise.resolve(
              htmlResponse(
                '<meta property="og:image" content="https://cdn.medal.tv/clip/abc.png">',
              ),
            )) as FetchImpl);
      global.fetch = fetchMock as unknown as typeof fetch;

      const first = await service.getMedalThumbnail('abc123');
      expect(first?.contentType).toBe('image/png');
      expect(first?.buffer).toBeInstanceOf(Buffer);
      const callsAfterFirst = fetchMock.mock.calls.length;

      // A second request within TTL is served from cache — no new fetches.
      const second = await service.getMedalThumbnail('abc123');
      expect(second?.buffer).toEqual(first?.buffer);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it('returns null for an invalid clip id (no outbound fetch)', async () => {
      const service = makeService();
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      expect(await service.getMedalThumbnail('bad id!')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when the clip page has no og:image', async () => {
      const service = makeService();
      global.fetch = jest.fn(() =>
        Promise.resolve(htmlResponse('<html>no meta here</html>')),
      ) as unknown as typeof fetch;
      expect(await service.getMedalThumbnail('unknown')).toBeNull();
    });

    it('rejects an og:image hosted off medal.tv (SSRF guard)', async () => {
      const service = makeService();
      global.fetch = jest.fn(() =>
        Promise.resolve(
          htmlResponse('<meta property="og:image" content="https://evil.example/x.png">'),
        ),
      ) as unknown as typeof fetch;
      expect(await service.getMedalThumbnail('abc123')).toBeNull();
    });
  });

  describe('enrichYouTube', () => {
    it('returns null when no API key is configured (no fetch)', async () => {
      const service = makeService('');
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      expect(await service.enrichYouTube('dQw4w9WgXcQ')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches title + duration once per id and caches the result', async () => {
      const service = makeService('test-key');
      const fetchMock = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [
                { snippet: { title: 'Never Gonna' }, contentDetails: { duration: 'PT3M32S' } },
              ],
            }),
        }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const first = await service.enrichYouTube('dQw4w9WgXcQ');
      expect(first).toEqual({ title: 'Never Gonna', durationSeconds: 212 });

      const second = await service.enrichYouTube('dQw4w9WgXcQ');
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(1); // cached — quota-safe.
    });

    it('does NOT cache a transient failure — a later call retries', async () => {
      const service = makeService('test-key');
      const fetchMock = jest
        .fn()
        // First call: quota-exceeded 403 (transient) → must not be cached.
        .mockResolvedValueOnce({ ok: false, status: 403 })
        // Second call: succeeds once the quota resets.
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [{ snippet: { title: 'Recovered' }, contentDetails: { duration: 'PT10S' } }],
            }),
        });
      global.fetch = fetchMock;

      expect(await service.enrichYouTube('dQw4w9WgXcQ')).toBeNull();
      const retried = await service.enrichYouTube('dQw4w9WgXcQ');
      expect(retried).toEqual({ title: 'Recovered', durationSeconds: 10 });
      expect(fetchMock).toHaveBeenCalledTimes(2); // retried, not served from a poisoned cache.
    });
  });
});
