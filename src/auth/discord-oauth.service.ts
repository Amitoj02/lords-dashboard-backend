import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DiscordGuild, DiscordTokenResponse, DiscordUser } from './types/discord-api.types';

/**
 * Thin wrapper around Discord's OAuth2 + REST endpoints using the global `fetch`.
 * Stateless and side-effect-free (no DB) so it is trivial to unit-test by
 * mocking `global.fetch`.
 */
@Injectable()
export class DiscordOAuthService {
  private readonly logger = new Logger(DiscordOAuthService.name);
  private readonly apiBase = 'https://discord.com/api/v10';

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private get discord() {
    return this.config.get('discord', { infer: true });
  }

  /** The Discord authorize URL the browser is redirected to (step 1). */
  buildAuthorizeUrl(state: string): string {
    const { clientId, callbackUrl, scopes } = this.discord;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      prompt: 'consent',
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  /** Exchange an authorization code for tokens (step 3). */
  async exchangeCode(code: string): Promise<DiscordTokenResponse> {
    const { clientId, clientSecret, callbackUrl } = this.discord;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
    });

    const res = await fetch(`${this.apiBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      this.logger.warn(`Discord token exchange failed: ${res.status}`);
      throw new UnauthorizedException('Discord authorization failed');
    }
    return (await res.json()) as DiscordTokenResponse;
  }

  /** Fetch the authenticated user's profile (identify scope). */
  async fetchUser(accessToken: string): Promise<DiscordUser> {
    const res = await fetch(`${this.apiBase}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      this.logger.warn(`Discord profile fetch failed: ${res.status}`);
      throw new UnauthorizedException('Could not retrieve Discord profile');
    }
    return (await res.json()) as DiscordUser;
  }

  /** Fetch the user's guilds (guilds scope). Returns [] on failure. */
  async fetchGuilds(accessToken: string): Promise<DiscordGuild[]> {
    const res = await fetch(`${this.apiBase}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      this.logger.warn(`Discord guilds fetch failed: ${res.status}`);
      return [];
    }
    return (await res.json()) as DiscordGuild[];
  }

  /** Whether the user belongs to the configured regiment guild. */
  async isMemberOfGuild(accessToken: string, guildId: string): Promise<boolean> {
    if (!guildId) return false;
    const guilds = await this.fetchGuilds(accessToken);
    return guilds.some((g) => g.id === guildId);
  }

  /** Build the CDN avatar URL from the user's avatar hash. */
  buildAvatarUrl(userId: string, avatarHash: string | null | undefined): string | null {
    if (!avatarHash) return null;
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
  }
}
