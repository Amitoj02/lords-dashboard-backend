import { Response } from 'express';
import { OEmbedController } from './oembed.controller';

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
    controller = new OEmbedController();
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
    author?: string,
    authorUrl?: string,
    provider?: string,
    providerUrl?: string,
  ): Record<string, unknown> => {
    controller.oembed(author, authorUrl, provider, providerUrl, res);
    return body as Record<string, unknown>;
  };

  it('returns a valid oEmbed envelope with the author and provider lines', () => {
    const payload = call(
      'Captain · 9 decorations',
      'https://lordsofholdfast.com/u/@panda',
      'Lords Regiment',
      'https://lordsofholdfast.com',
    );

    expect(payload).toEqual({
      // `link` rather than `rich`: `rich` REQUIRES an `html` field, Discord
      // refuses to render a non-allowlisted one anyway, and an oEmbed response
      // that does not validate is discarded whole.
      version: '1.0',
      type: 'link',
      provider_name: 'Lords Regiment',
      provider_url: 'https://lordsofholdfast.com',
      author_name: 'Captain · 9 decorations',
      author_url: 'https://lordsofholdfast.com/u/@panda',
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
    // These values are ours today, composed server-side from a member id. The
    // check is here because the only thing making that true is that nobody has
    // yet written a caller which forwards a parameter — and `author_url` becomes
    // the click target of a line inside a Discord embed.
    const payload = call('Captain', 'javascript:alert(1)', 'Lords', 'data:text/html,x');

    expect(payload['author_name']).toBe('Captain');
    expect(payload).not.toHaveProperty('author_url');
    expect(payload).not.toHaveProperty('provider_url');
  });

  it('collapses whitespace and clamps an over-long field', () => {
    const payload = call('a'.repeat(400), undefined, 'Lords   \n  Regiment');

    expect((payload['author_name'] as string).length).toBe(255);
    expect(payload['provider_name']).toBe('Lords Regiment');
  });
});
