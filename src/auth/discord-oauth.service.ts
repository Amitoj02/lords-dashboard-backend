import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DiscordTokenResponse, DiscordUser } from './types/discord-api.types';

/**
 * Thin wrapper around Discord's OAuth2 + REST endpoints using the global `fetch`.
 * Stateless and side-effect-free (no DB) so it is trivial to unit-test by
 * mocking `global.fetch`.
 */
@Injectable()
export class DiscordOAuthService {
  private readonly logger = new Logger(DiscordOAuthService.name);
  private readonly apiBase = 'https://discord.com/api/v10';
  /** Ceiling on each Discord call so a hung response cannot tie up the
   * unauthenticated callback request indefinitely (LDA-L8). */
  private static readonly FETCH_TIMEOUT_MS = 10_000;

  constructor(protected readonly config: ConfigService<AppConfig, true>) {}

  private get discord() {
    return this.config.get('discord', { infer: true });
  }

  /**
   * The Discord authorize URL the browser is redirected to (step 1). The
   * optional `persona` is ignored by the real flow; the mock uses it to pick
   * which canned user to sign in as (see MockDiscordOAuthService).
   */
  buildAuthorizeUrl(state: string, _persona?: string): string {
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
      signal: AbortSignal.timeout(DiscordOAuthService.FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(DiscordOAuthService.FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.warn(`Discord profile fetch failed: ${res.status}`);
      throw new UnauthorizedException('Could not retrieve Discord profile');
    }
    return (await res.json()) as DiscordUser;
  }

  /** Build the CDN avatar URL from the user's avatar hash. */
  buildAvatarUrl(userId: string, avatarHash: string | null | undefined): string | null {
    if (!avatarHash) return null;
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
  }
}
