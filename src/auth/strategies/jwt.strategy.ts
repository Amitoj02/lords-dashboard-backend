import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../../config/configuration';
import { SessionContextService } from '../session-context.service';
import { AuthenticatedUser } from '../types/authenticated-user.interface';
import { JwtPayload } from '../types/jwt-payload.interface';

/** Reads the JWT from `Authorization: Bearer` or the `access_token` cookie. */
const cookieExtractor = (req: Request): string | null => {
  const cookies = req.cookies as Record<string, string> | undefined;
  const token = cookies?.access_token;
  return typeof token === 'string' ? token : null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly sessionContext: SessionContextService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        cookieExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get('jwt', { infer: true }).secret,
    });
  }

  /**
   * The token only carries stable identity claims (`sub`, `did`). Role,
   * regiment and member id are resolved fresh from the DB per request
   * (T-0046/47), and a token whose `iat` predates the identity's session cutoff
   * is rejected (T-0048). `request.user` keeps the same {@link AuthenticatedUser}
   * shape, so no downstream consumer changes.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid token');
    }

    const context = await this.sessionContext.resolve(payload.sub);
    if (!context) {
      throw new UnauthorizedException('Account no longer exists');
    }

    // iat-based session invalidation: reject any token issued before the
    // identity's session cutoff. `iat` and the cutoff are compared at
    // whole-second granularity (iat is standard second-precision), so a token
    // issued in the same second as a bump is not falsely rejected.
    if (
      context.sessionsValidFromSec > 0 &&
      typeof payload.iat === 'number' &&
      payload.iat < context.sessionsValidFromSec
    ) {
      throw new UnauthorizedException('Session expired, please sign in again');
    }

    return {
      identityId: context.identityId,
      memberId: context.memberId,
      discordUserId: context.discordUserId,
      role: context.role,
      regimentId: context.regimentId,
    };
  }
}
