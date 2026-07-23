import { randomBytes } from 'crypto';
import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { CurrentUserDto } from './dto/current-user.dto';
import { GuildStatusDto } from './dto/guild-status.dto';
import { GuildMembershipService } from './guild-membership.service';
import { AuthenticatedUser } from './types/authenticated-user.interface';

const STATE_COOKIE = 'discord_oauth_state';
const TOKEN_COOKIE = 'access_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly guildMembership: GuildMembershipService,
  ) {}

  @Public()
  @Get('discord')
  @ApiOperation({
    summary: 'Begin Discord OAuth2 sign-in (302 redirect to Discord)',
    description:
      'When the Discord mock is active, the optional `as` query selects which ' +
      'canned persona to sign in as (e.g. `owner`, `recruit`, or any label). ' +
      'Ignored by the real Discord flow.',
  })
  discordLogin(@Query('as') persona: string | undefined, @Res() res: Response): void {
    // The `?as=` persona selector is ONLY meaningful when the Discord mock is
    // active. Ignore it entirely otherwise (LDA-C1) so it can never influence the
    // real OAuth flow — belt-and-suspenders on top of the real service ignoring it.
    const mockActive = this.config.get('discord', { infer: true }).mock;
    const requestedPersona = mockActive ? persona : undefined;
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, this.cookieOptions(10 * 60 * 1000));
    res.redirect(this.authService.getLoginUrl(state, requestedPersona));
  }

  @Public()
  @Get('discord/callback')
  @ApiOperation({
    summary: 'Discord OAuth2 callback — upserts the identity + member and issues a JWT',
  })
  async discordCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const frontend = this.config.get('frontend', { infer: true });
    const cookies = req.cookies as Record<string, string> | undefined;
    const cookieState = cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE);

    // CSRF protection: the state we set must round-trip.
    if (!code || !state || !cookieState || state !== cookieState) {
      res.redirect(`${frontend.authFailureRedirect}?error=invalid_state`);
      return;
    }

    try {
      const result = await this.authService.signInWithDiscord(code, req.ip ?? null);
      res.cookie(TOKEN_COOKIE, result.token, this.cookieOptions(7 * 24 * 60 * 60 * 1000));
      const url = new URL(frontend.authSuccessRedirect);
      // Deliver the JWT in the URL FRAGMENT, never the query string (LDA-H4). A
      // fragment is not transmitted to any server, so the token never lands in the
      // nginx/Caddy/Cloudflare access logs or in the `Referer` header on the first
      // same-origin navigation. The SPA reads it from location.hash and scrubs it
      // immediately with history.replaceState. The httpOnly cookie set above is the
      // primary, JS-inaccessible handoff. JWT chars (base64url + '.') are all
      // fragment-safe, so no percent-encoding is needed.
      url.hash = `token=${result.token}&isMember=${String(result.isMember)}`;
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.redirect(url.toString());
    } catch {
      res.redirect(`${frontend.authFailureRedirect}?error=auth_failed`);
    }
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The current authenticated user (CurrentUser projection)' })
  @ApiOkResponse({ type: CurrentUserDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<CurrentUserDto> {
    return this.authService.getCurrentUser(user);
  }

  @Get('guild-status')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Re-check whether the caller is still in the regiment Discord guild',
    description:
      'The ONLY endpoint that may ask the bot about the caller (T-0167). The verdict is ' +
      'cached per identity for 15 minutes and concurrent calls collapse to one lookup, so ' +
      'polling this is cheap. When the bot cannot answer the last known verdict is kept and ' +
      '`degraded` is true — the check fails OPEN and never denies on an outage.',
  })
  @ApiOkResponse({ type: GuildStatusDto })
  guildStatus(@CurrentUser() user: AuthenticatedUser): Promise<GuildStatusDto> {
    return this.guildMembership.getStatus(user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Clear the session cookie and invalidate outstanding tokens' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    // Advance the identity's session cutoff so this token (and any concurrent
    // ones) are rejected on their next use, not just cleared from this browser.
    await this.authService.logout(user);
    res.clearCookie(TOKEN_COOKIE);
    return { success: true };
  }

  private cookieOptions(maxAge: number): CookieOptions {
    const isProd = this.config.get('env', { infer: true }) === 'production';
    return { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge };
  }
}
