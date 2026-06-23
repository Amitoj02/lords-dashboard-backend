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
import { AuthenticatedUser } from './types/authenticated-user.interface';

const STATE_COOKIE = 'discord_oauth_state';
const TOKEN_COOKIE = 'access_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Public()
  @Get('discord')
  @ApiOperation({ summary: 'Begin Discord OAuth2 sign-in (302 redirect to Discord)' })
  discordLogin(@Res() res: Response): void {
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, this.cookieOptions(10 * 60 * 1000));
    res.redirect(this.authService.getLoginUrl(state));
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
      url.searchParams.set('token', result.token);
      url.searchParams.set('isMember', String(result.isMember));
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

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Clear the session cookie' })
  logout(@Res({ passthrough: true }) res: Response): { success: boolean } {
    res.clearCookie(TOKEN_COOKIE);
    return { success: true };
  }

  private cookieOptions(maxAge: number): CookieOptions {
    const isProd = this.config.get('env', { infer: true }) === 'production';
    return { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge };
  }
}
