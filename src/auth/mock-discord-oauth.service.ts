import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DiscordOAuthService } from './discord-oauth.service';
import { DiscordTokenResponse, DiscordUser } from './types/discord-api.types';

/** A canned Discord user the mock can "sign in" as. */
interface MockPersona {
  id: string;
  username: string;
  globalName: string;
  email: string;
}

/**
 * Well-known personas. `owner` deliberately uses the seeded dev-owner's Discord
 * snowflake, so signing in through the mock resolves the real seeded Owner
 * member (full capabilities — ideal for exercising admin flows). `recruit` is a
 * brand-new identity with no member row, which lands on the /apply flow.
 *
 * Any other `?as=` label produces a stable synthetic persona derived
 * deterministically from the label, so `?as=alice` always returns the same
 * user across logins.
 */
const KNOWN_PERSONAS: Record<string, MockPersona> = {
  owner: {
    id: '100000000000000001',
    username: 'lord_commander',
    globalName: 'Lord Commander',
    email: 'owner@lords.test',
  },
  recruit: {
    id: '200000000000000042',
    username: 'recruit_rex',
    globalName: 'Recruit Rex',
    email: 'recruit@lords.test',
  },
};

const TOKEN_PREFIX = 'mock-access:';
const CODE_PREFIX = 'mock:';

/**
 * Drop-in replacement for {@link DiscordOAuthService} that performs NO network
 * I/O. It simulates the OAuth2 round-trip entirely in-process:
 *
 *   1. buildAuthorizeUrl() redirects the browser straight back to the API's own
 *      /auth/discord/callback (same origin, so the CSRF state cookie survives),
 *      carrying the chosen persona in the `code`.
 *   2. exchangeCode() echoes the persona back inside a fake access token.
 *   3. fetchUser() decodes the persona and returns a canned Discord profile.
 *
 * Wired in place of the real service when `discord.mock` is true (see
 * AuthModule). To go live: set DISCORD_MOCK=false and provide real
 * DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET — no other code changes.
 */
@Injectable()
export class MockDiscordOAuthService extends DiscordOAuthService {
  private readonly mockLogger = new Logger(MockDiscordOAuthService.name);

  constructor(config: ConfigService<AppConfig, true>) {
    super(config);
    this.mockLogger.warn(
      'Discord OAuth is MOCKED (DISCORD_MOCK). No real Discord app is used — ' +
        'set DISCORD_MOCK=false with real credentials to go live.',
    );
  }

  private get discordCfg() {
    return this.config.get('discord', { infer: true });
  }

  /**
   * Instead of Discord's consent screen, redirect the browser directly to our
   * own callback with a synthetic code. The `state` is preserved so the
   * controller's CSRF check passes unchanged.
   */
  override buildAuthorizeUrl(state: string, persona?: string): string {
    const { callbackUrl, mockDefaultPersona } = this.discordCfg;
    const chosen = (persona || mockDefaultPersona || 'owner').trim();
    const url = new URL(callbackUrl);
    url.searchParams.set('code', `${CODE_PREFIX}${chosen}`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  override exchangeCode(code: string): Promise<DiscordTokenResponse> {
    const persona = code.startsWith(CODE_PREFIX)
      ? code.slice(CODE_PREFIX.length)
      : this.discordCfg.mockDefaultPersona;
    return Promise.resolve({
      access_token: `${TOKEN_PREFIX}${persona}`,
      token_type: 'Bearer',
      expires_in: 604800,
      refresh_token: `mock-refresh:${persona}`,
      scope: this.discordCfg.scopes.join(' '),
    });
  }

  override fetchUser(accessToken: string): Promise<DiscordUser> {
    const persona = accessToken.startsWith(TOKEN_PREFIX)
      ? accessToken.slice(TOKEN_PREFIX.length)
      : this.discordCfg.mockDefaultPersona;
    const p = this.resolvePersona(persona);
    return Promise.resolve({
      id: p.id,
      username: p.username,
      global_name: p.globalName,
      discriminator: '0',
      avatar: null,
      email: p.email,
      verified: true,
    });
  }

  /** Known persona, or a deterministic synthetic one derived from the label. */
  private resolvePersona(label: string): MockPersona {
    const key = label.toLowerCase();
    if (KNOWN_PERSONAS[key]) return KNOWN_PERSONAS[key];

    // Deterministic 18-digit snowflake so the same label always maps to the
    // same identity (repeat logins reuse the row, not spawn duplicates).
    const digest = createHash('sha256').update(key).digest('hex');
    const id = ((BigInt('0x' + digest.slice(0, 16)) % 900000000000000000n) + 100000000000000000n)
      .toString()
      .slice(0, 18);
    const safe = key.replace(/[^a-z0-9_]/g, '_').slice(0, 24) || 'guest';
    return {
      id,
      username: safe,
      globalName: safe.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      email: `${safe}@lords.test`,
    };
  }
}
