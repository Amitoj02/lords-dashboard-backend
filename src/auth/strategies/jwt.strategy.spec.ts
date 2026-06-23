import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { MemberRole } from '../../common/enums';
import { JwtPayload } from '../types/jwt-payload.interface';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const config = {
    get: () => ({ secret: 'test-secret', expiresIn: '7d', encryptionKey: 'k' }),
  } as unknown as ConfigService<AppConfig, true>;
  const strategy = new JwtStrategy(config);

  it('maps a payload to the AuthenticatedUser shape', () => {
    const payload: JwtPayload = {
      sub: 'identity-1',
      mid: 'member-1',
      did: 'discord-1',
      role: MemberRole.Owner,
      rid: 'regiment-1',
    };
    expect(strategy.validate(payload)).toEqual({
      identityId: 'identity-1',
      memberId: 'member-1',
      discordUserId: 'discord-1',
      role: MemberRole.Owner,
      regimentId: 'regiment-1',
    });
  });

  it('preserves a null memberId (identity-only session)', () => {
    const user = strategy.validate({
      sub: 'identity-1',
      mid: null,
      did: 'discord-1',
      role: MemberRole.Applicant,
      rid: 'regiment-1',
    });
    expect(user.memberId).toBeNull();
    expect(user.role).toBe(MemberRole.Applicant);
  });

  it('throws Unauthorized when sub is missing', () => {
    expect(() => strategy.validate({} as JwtPayload)).toThrow(UnauthorizedException);
  });
});
