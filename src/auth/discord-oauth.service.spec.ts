import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DiscordOAuthService } from './discord-oauth.service';

const fakeResponse = (ok: boolean, body: unknown, status = 200) =>
  ({ ok, status, json: () => Promise.resolve(body) }) as unknown as Response;

describe('DiscordOAuthService', () => {
  let service: DiscordOAuthService;

  const config = {
    get: jest.fn().mockReturnValue({
      clientId: 'cid',
      clientSecret: 'sec',
      callbackUrl: 'http://localhost/cb',
      scopes: ['identify', 'email'],
      guildId: 'gid',
    }),
  } as unknown as ConfigService<AppConfig, true>;

  beforeEach(() => {
    service = new DiscordOAuthService(config);
    jest.restoreAllMocks();
  });

  it('buildAuthorizeUrl includes client_id, scope, state', () => {
    const url = service.buildAuthorizeUrl('st8');
    expect(url).toContain('client_id=cid');
    // No `guilds` scope — membership is resolved from the bot (T-0050/T-0051).
    expect(url).toContain('scope=identify+email');
    expect(url).not.toContain('guilds');
    expect(url).toContain('state=st8');
    expect(url).toContain('response_type=code');
  });

  it('still asks for identify+email ONLY — guild gating adds no OAuth scope (T-0166)', () => {
    // Surfacing guild membership on the session (T-0166) must not widen the
    // consent screen: the verdict comes from the bot, so asking the user for
    // `guilds` would be re-collecting data we deliberately stopped collecting.
    const scope = new URL(service.buildAuthorizeUrl('st8')).searchParams.get('scope');
    expect(scope).toBe('identify email');
  });

  it('exchangeCode returns the token payload on success', async () => {
    const token = {
      access_token: 'at',
      token_type: 'Bearer',
      expires_in: 604800,
      scope: 'identify',
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(true, token));
    await expect(service.exchangeCode('code')).resolves.toEqual(token);
  });

  it('exchangeCode throws Unauthorized on a non-ok response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(false, {}, 400));
    await expect(service.exchangeCode('bad')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fetchUser returns the Discord profile', async () => {
    const user = { id: '42', username: 'newbie' };
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(true, user));
    await expect(service.fetchUser('at')).resolves.toEqual(user);
  });

  it('fetchUser throws Unauthorized when Discord rejects the token', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeResponse(false, {}, 401));
    await expect(service.fetchUser('bad')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('buildAvatarUrl picks gif for animated, png otherwise, null when missing', () => {
    expect(service.buildAvatarUrl('42', 'a_anim')).toContain('/42/a_anim.gif');
    expect(service.buildAvatarUrl('42', 'static')).toContain('/42/static.png');
    expect(service.buildAvatarUrl('42', null)).toBeNull();
  });
});
