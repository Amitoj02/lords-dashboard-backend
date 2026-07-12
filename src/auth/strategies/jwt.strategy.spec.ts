import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { MemberRole } from '../../common/enums';
import { ResolvedSessionContext, SessionContextService } from '../session-context.service';
import { JwtPayload } from '../types/jwt-payload.interface';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const config = {
    get: () => ({ secret: 'test-secret', expiresIn: '7d', encryptionKey: 'k' }),
  } as unknown as ConfigService<AppConfig, true>;

  const baseContext: ResolvedSessionContext = {
    identityId: 'identity-1',
    discordUserId: 'discord-1',
    memberId: 'member-1',
    role: MemberRole.Owner,
    regimentId: 'regiment-1',
    sessionsValidFromSec: 0,
  };

  const resolve = jest.fn();
  const sessionContext = { resolve } as unknown as SessionContextService;
  const strategy = new JwtStrategy(config, sessionContext);

  beforeEach(() => jest.clearAllMocks());

  it('resolves the payload to the live AuthenticatedUser (role/regiment/member from DB)', async () => {
    resolve.mockResolvedValue(baseContext);
    const user = await strategy.validate({ sub: 'identity-1', did: 'discord-1', iat: 1000 });
    expect(resolve).toHaveBeenCalledWith('identity-1');
    expect(user).toEqual({
      identityId: 'identity-1',
      memberId: 'member-1',
      discordUserId: 'discord-1',
      role: MemberRole.Owner,
      regimentId: 'regiment-1',
    });
  });

  it('preserves a null memberId (identity-only session resolves as Applicant)', async () => {
    resolve.mockResolvedValue({ ...baseContext, memberId: null, role: MemberRole.Applicant });
    const user = await strategy.validate({ sub: 'identity-1', did: 'discord-1', iat: 1000 });
    expect(user.memberId).toBeNull();
    expect(user.role).toBe(MemberRole.Applicant);
  });

  it('throws Unauthorized when sub is missing', async () => {
    await expect(strategy.validate({} as JwtPayload)).rejects.toThrow(UnauthorizedException);
  });

  it('throws Unauthorized when the identity no longer exists', async () => {
    resolve.mockResolvedValue(null);
    await expect(strategy.validate({ sub: 'gone', did: 'd', iat: 1000 })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token issued before the identity session cutoff (T-0048)', async () => {
    resolve.mockResolvedValue({ ...baseContext, sessionsValidFromSec: 2000 });
    await expect(strategy.validate({ sub: 'identity-1', did: 'd', iat: 1999 })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a token issued in the same second as the cutoff (no false rejection)', async () => {
    resolve.mockResolvedValue({ ...baseContext, sessionsValidFromSec: 1000 });
    const user = await strategy.validate({ sub: 'identity-1', did: 'd', iat: 1000 });
    expect(user.identityId).toBe('identity-1');
  });
});
