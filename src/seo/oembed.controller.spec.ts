import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AppConfig } from '../config/configuration';
import { OEmbedController } from './oembed.controller';

const SITE = 'https://lordsofholdfast.com';

/**
 * `/api/oembed` — the author line on a Discord card (T-0297).
 *
 * The endpoint resolves nothing: the shell composes the strings and puts them in
 * the query, and this echoes them into oEmbed's envelope. So what is worth
 * testing is the envelope's shape (Discord discards the whole response if it does
 * not validate, losing the line rather than degrading) and the two guards on what
 * gets echoed back.
 */
describe('OEmbedController', () => {
  let controller: OEmbedController;
  let res: Response;
  let headers: Record<string, string>;
  let body: unknown;

  beforeEach(() => {
    controller = new OEmbedController({
      get: () => ({ url: SITE }),
    } as unknown as ConfigService<AppConfig, true>);
    headers = {};
    body = undefined;
    res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      json: (payload: unknown) => {
        body = payload;
      },
    } as unknown as Response;
  });

  const call = (
    author?: unknown,
    authorUrl?: unknown,
    provider?: unknown,
    providerUrl?: unknown,
  ): Record<string, unknown> => {
    controller.oembed(author, authorUrl, provider, providerUrl, res);
    return body as Record<string, unknown>;
  };

  it('returns a valid oEmbed envelope with the author and provider lines', () => {
    const payload = call('Captain · 9 decorations', `${SITE}/u/@panda`, 'Lords Regiment', SITE);

    expect(payload).toEqual({
      // `link` rather than `rich`: `rich` REQUIRES an `html` field, Discord
      // refuses to render a non-allowlisted one anyway, and an oEmbed response
      // that does not validate is discarded whole.
      version: '1.0',
      type: 'link',
      provider_name: 'Lords Regiment',
      provider_url: `${SITE}/`,
      author_name: 'Captain · 9 decorations',
      author_url: `${SITE}/u/@panda`,
    });
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8');
    // The same ten minutes the shells use. The two documents describe one page.
    expect(headers['Cache-Control']).toBe('public, max-age=600');
  });

  it('still validates when nothing was supplied', () => {
    // A malformed response costs the author line on every card, so the two
    // required fields are unconditional.
    expect(call()).toEqual({ version: '1.0', type: 'link' });
  });

  it('drops a URL that is not http(s)', () => {
    const payload = call('Captain', 'javascript:alert(1)', 'Lords', 'data:text/html,x');

    expect(payload['author_name']).toBe('Captain');
    expect(payload).not.toHaveProperty('author_url');
    expect(payload).not.toHaveProperty('provider_url');
  });

  it('drops a URL on another origin, however plausible it looks', () => {
    // The check used to be "starts with http", which let anyone put a discovery
    // <link> on their own page naming this endpoint and have the regiment's apex
    // domain serve an author line pointing wherever they chose. `URL.origin`
    // rather than a prefix match, because `lordsofholdfast.com.evil.test` passes
    // `startsWith` and is a different site.
    const payload = call('Captain', 'https://lordsofholdfast.com.evil.test/claim', 'Lords', SITE);

    expect(payload['author_name']).toBe('Captain');
    expect(payload).not.toHaveProperty('author_url');
    expect(payload['provider_url']).toBe(`${SITE}/`);
  });

  // ── EXPRESS DOES NOT GIVE YOU A STRING (T-0297) ──────────────────────────
  // `@Query('author')` was typed `string | undefined`, which is a claim the
  // framework does not honour: `qs` yields an ARRAY for a repeated key and a
  // plain OBJECT for a bracketed one, and the global ValidationPipe coerces only
  // Number and Boolean. Both shapes reached `.replace` and 500'd a `@Public()`
  // route, and the array also defeated the scheme check outright — `RegExp.test`
  // stringifies its argument, so `['https://ok', 'javascript:…']` joined to a
  // string starting with `https://`, matched, and then the ARRAY was emitted.
  describe('a query parameter that is not a string', () => {
    it('does not 500 on a repeated key', () => {
      expect(() => call(['a', 'b'], undefined, ['x', 'y'])).not.toThrow();
      expect(call(['a', 'b'])).toEqual({ version: '1.0', type: 'link' });
    });

    it('does not 500 on a bracketed key', () => {
      expect(() => call({ evil: 'yes' })).not.toThrow();
      expect(call(undefined, undefined, { evil: 'yes' })).toEqual({
        version: '1.0',
        type: 'link',
      });
    });

    it('never lets an array smuggle a javascript: URL past the scheme check', () => {
      const payload = call('Captain', [`${SITE}/ok`, 'javascript:alert(1)']);

      expect(payload).not.toHaveProperty('author_url');
      expect(JSON.stringify(payload)).not.toContain('javascript:');
    });
  });

  it('collapses whitespace and clamps an over-long field', () => {
    const payload = call('a'.repeat(400), undefined, 'Lords   \n  Regiment');

    expect((payload['author_name'] as string).length).toBe(255);
    expect(payload['provider_name']).toBe('Lords Regiment');
  });

  it('emits no empty field for a whitespace-only value', () => {
    // `{author_name: ""}` is a field asserting nothing, and Discord would render
    // a blank bold line above the title rather than no line at all.
    expect(call('   \n  ')).toEqual({ version: '1.0', type: 'link' });
  });
});
