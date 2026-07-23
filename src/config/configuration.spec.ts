import type { ConfigService } from '@nestjs/config';
import configuration, { AppConfig } from './configuration';
import { MockDiscordOAuthService } from '../auth/mock-discord-oauth.service';

/**
 * LDA-C1 regression guard: the Discord OAuth mock is an authentication bypass and
 * must never silently activate (or be constructible) in production.
 */
describe('LDA-C1 — Discord OAuth mock fails closed in production', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    // Fresh copy per test so mutations do not leak between cases.
    process.env = { ...ORIGINAL };
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  describe('configuration() default for discord.mock', () => {
    it('does NOT auto-enable the mock in production when DISCORD_CLIENT_ID is empty', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DISCORD_CLIENT_ID;
      delete process.env.DISCORD_MOCK;
      expect(configuration().discord.mock).toBe(false);
    });

    it('auto-enables the mock in development when DISCORD_CLIENT_ID is empty', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.DISCORD_CLIENT_ID;
      delete process.env.DISCORD_MOCK;
      expect(configuration().discord.mock).toBe(true);
    });

    it('respects an explicit DISCORD_MOCK=true even in production (guarded at boot)', () => {
      process.env.NODE_ENV = 'production';
      process.env.DISCORD_MOCK = 'true';
      expect(configuration().discord.mock).toBe(true);
    });

    it('does not auto-enable the bot mock in production when no token is set', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_BOT_MOCK;
      expect(configuration().discord.botMock).toBe(false);
    });
  });

  describe('MockDiscordOAuthService constructor guard', () => {
    const stubConfig = (env: AppConfig['env']): ConfigService<AppConfig, true> =>
      ({
        get: (key: string) =>
          key === 'env'
            ? env
            : {
                scopes: ['identify', 'email'],
                callbackUrl: 'http://localhost/callback',
                mockDefaultPersona: 'owner',
              },
      }) as unknown as ConfigService<AppConfig, true>;

    it('throws when constructed in production without ALLOW_MOCKS_IN_PROD', () => {
      delete process.env.ALLOW_MOCKS_IN_PROD;
      expect(() => new MockDiscordOAuthService(stubConfig('production'))).toThrow(/production/i);
    });

    it('does NOT throw in production when ALLOW_MOCKS_IN_PROD=true', () => {
      process.env.ALLOW_MOCKS_IN_PROD = 'true';
      expect(() => new MockDiscordOAuthService(stubConfig('production'))).not.toThrow();
    });

    it('does NOT throw outside production', () => {
      delete process.env.ALLOW_MOCKS_IN_PROD;
      expect(() => new MockDiscordOAuthService(stubConfig('development'))).not.toThrow();
    });
  });
});
