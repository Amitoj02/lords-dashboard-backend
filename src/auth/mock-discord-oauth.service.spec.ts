import { ConfigService } from '@nestjs/config';
import { AppConfig, DiscordConfig } from '../config/configuration';
import { MockDiscordOAuthService } from './mock-discord-oauth.service';

/** Minimal ConfigService stub returning a fixed Discord config block. */
function configWith(overrides: Partial<DiscordConfig> = {}): ConfigService<AppConfig, true> {
  const discord: DiscordConfig = {
    clientId: '',
    clientSecret: '',
    callbackUrl: 'http://localhost:3000/api/auth/discord/callback',
    scopes: ['identify', 'email', 'guilds'],
    guildId: '999',
    mock: true,
    mockDefaultPersona: 'owner',
    ...overrides,
  };
  return {
    get: (key: string) => (key === 'discord' ? discord : undefined),
  } as unknown as ConfigService<AppConfig, true>;
}

describe('MockDiscordOAuthService', () => {
  it('round-trips a persona from authorize URL → token → user (owner)', async () => {
    const svc = new MockDiscordOAuthService(configWith());

    const url = new URL(svc.buildAuthorizeUrl('state-123', 'owner'));
    expect(url.origin + url.pathname).toBe('http://localhost:3000/api/auth/discord/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    const code = url.searchParams.get('code')!;

    const token = await svc.exchangeCode(code);
    const user = await svc.fetchUser(token.access_token);

    // The owner persona uses the seeded dev-owner snowflake so it resolves the
    // real seeded Owner member.
    expect(user.id).toBe('100000000000000001');
    expect(user.username).toBe('lord_commander');
  });

  it('falls back to the configured default persona when none is given', async () => {
    const svc = new MockDiscordOAuthService(configWith({ mockDefaultPersona: 'recruit' }));
    const url = new URL(svc.buildAuthorizeUrl('s'));
    const user = await svc.fetchUser(
      (await svc.exchangeCode(url.searchParams.get('code')!)).access_token,
    );
    expect(user.id).toBe('200000000000000042');
  });

  it('derives a stable synthetic identity for an unknown persona label', async () => {
    const svc = new MockDiscordOAuthService(configWith());
    const first = await svc.fetchUser((await svc.exchangeCode('mock:alice')).access_token);
    const second = await svc.fetchUser((await svc.exchangeCode('mock:alice')).access_token);
    expect(first.id).toBe(second.id); // deterministic
    expect(first.id).toMatch(/^\d{18}$/);
    expect(first.username).toBe('alice');
    // Distinct labels yield distinct ids.
    const bob = await svc.fetchUser((await svc.exchangeCode('mock:bob')).access_token);
    expect(bob.id).not.toBe(first.id);
  });

  it('treats every persona as a guild member', async () => {
    const svc = new MockDiscordOAuthService(configWith());
    await expect(svc.isMemberOfGuild()).resolves.toBe(true);
  });
});
