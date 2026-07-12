import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberRole, MemberStatus } from '../common/enums';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { AuthzService } from '../authz/authz.service';
import { AuthService } from './auth.service';
import { DiscordOAuthService } from './discord-oauth.service';
import { SessionContextService } from './session-context.service';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { AuthenticatedUser } from './types/authenticated-user.interface';
import { JwtPayload } from './types/jwt-payload.interface';

type MockRepo<T extends object> = Partial<Record<keyof Repository<T>, jest.Mock>>;
const repoMock = <T extends object>(): MockRepo<T> => ({
  findOne: jest.fn(),
  create: jest.fn((x: unknown) => x),
  save: jest.fn((x: unknown) => Promise.resolve(x)),
});

const TOKEN = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  token_type: 'Bearer',
  expires_in: 604800,
  scope: 'identify email guilds',
};

const NEW_PROFILE = {
  id: '999000111222',
  username: 'newbie',
  global_name: 'New Bie',
  discriminator: '0',
  avatar: 'avatarhash',
  email: 'newbie@example.com',
};

describe('AuthService', () => {
  let service: AuthService;
  let identities: MockRepo<DiscordIdentity>;
  let members: MockRepo<Member>;
  let regiments: MockRepo<Regiment>;
  let discord: jest.Mocked<
    Pick<DiscordOAuthService, 'exchangeCode' | 'fetchUser' | 'isMemberOfGuild' | 'buildAvatarUrl'>
  >;
  let jwt: { signAsync: jest.Mock };
  let authz: { grantedCapabilities: jest.Mock };
  let sessionContext: { invalidate: jest.Mock; invalidateSessions: jest.Mock };

  beforeEach(async () => {
    identities = repoMock<DiscordIdentity>();
    members = repoMock<Member>();
    regiments = repoMock<Regiment>();
    authz = { grantedCapabilities: jest.fn().mockResolvedValue([]) };
    sessionContext = { invalidate: jest.fn(), invalidateSessions: jest.fn() };
    discord = {
      exchangeCode: jest.fn().mockResolvedValue(TOKEN),
      fetchUser: jest.fn().mockResolvedValue(NEW_PROFILE),
      isMemberOfGuild: jest.fn().mockResolvedValue(true),
      buildAvatarUrl: jest.fn().mockReturnValue('https://cdn/avatar.png'),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(DiscordIdentity), useValue: identities },
        { provide: getRepositoryToken(Member), useValue: members },
        { provide: getRepositoryToken(Regiment), useValue: regiments },
        { provide: DiscordOAuthService, useValue: discord },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue({ guildId: 'guild-1' }) },
        },
        { provide: AuthzService, useValue: authz },
        { provide: SessionContextService, useValue: sessionContext },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('signInWithDiscord', () => {
    it('creates a Discord identity (the user record) for a brand-new sign-in and issues an Applicant JWT', async () => {
      identities.findOne!.mockResolvedValue(null); // no existing identity
      identities.save!.mockImplementation((x: DiscordIdentity) =>
        Promise.resolve({ ...x, id: 'identity-new' }),
      );
      members.findOne!.mockResolvedValue(null); // not on the roster
      regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });

      const result = await service.signInWithDiscord('code', '1.2.3.4');

      // A proper user record was created from the Discord profile.
      expect(identities.create).toHaveBeenCalled();
      const saved = identities.save!.mock.calls[0][0] as DiscordIdentity;
      expect(saved).toMatchObject({
        discordUserId: '999000111222',
        discordTag: '@newbie',
        globalName: 'New Bie',
        email: 'newbie@example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        guildMember: true,
        lastSignInIp: '1.2.3.4',
      });
      expect(saved.tokenExpiresAt).toBeInstanceOf(Date);

      // No roster member yet.
      expect(result.isMember).toBe(false);
      expect(result.member).toBeNull();
      expect(members.save).not.toHaveBeenCalled();

      // The slim JWT carries only stable identity claims (T-0047): no role/mid/rid.
      const payload = jwt.signAsync.mock.calls[0][0] as JwtPayload;
      expect(payload).toEqual({ sub: 'identity-new', did: '999000111222' });
      expect(payload).not.toHaveProperty('mid');
      expect(payload).not.toHaveProperty('role');
      expect(payload).not.toHaveProperty('rid');
      expect(result.token).toBe('signed.jwt.token');
    });

    it('links an existing roster member and issues a JWT with the member role', async () => {
      const existingIdentity = { id: 'identity-owner', discordUserId: '100000000000000001' };
      identities.findOne!.mockResolvedValue(existingIdentity);
      identities.save!.mockImplementation((x: DiscordIdentity) => Promise.resolve(x));
      const member = {
        id: 'member-owner',
        role: MemberRole.Owner,
        status: MemberStatus.Active,
        regimentId: 'regiment-1',
        discordLinked: false,
        rank: { name: 'General' },
      } as unknown as Member;
      members.findOne!.mockResolvedValue(member);
      members.save!.mockImplementation((x: Member) => Promise.resolve(x));

      const result = await service.signInWithDiscord('code', null);

      expect(result.isMember).toBe(true);
      expect(result.member).toBe(member);
      // Returning member's last-seen + link flag are refreshed.
      const savedMember = members.save!.mock.calls[0][0] as Member;
      expect(savedMember.discordLinked).toBe(true);
      expect(savedMember.lastSeenAt).toBeInstanceOf(Date);

      // The slim JWT carries only { sub, did } (T-0047) — role/regiment/member
      // are resolved fresh per request now, so they are never embedded.
      const payload = jwt.signAsync.mock.calls[0][0] as JwtPayload;
      expect(payload).toEqual({ sub: 'identity-owner', did: '100000000000000001' });
    });

    it('does not check guild membership when no guild is configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuthService,
          { provide: getRepositoryToken(DiscordIdentity), useValue: identities },
          { provide: getRepositoryToken(Member), useValue: members },
          { provide: getRepositoryToken(Regiment), useValue: regiments },
          { provide: DiscordOAuthService, useValue: discord },
          { provide: JwtService, useValue: jwt },
          { provide: ConfigService, useValue: { get: () => ({ guildId: '' }) } },
          { provide: AuthzService, useValue: authz },
          { provide: SessionContextService, useValue: sessionContext },
        ],
      }).compile();
      const svc = module.get(AuthService);

      identities.findOne!.mockResolvedValue(null);
      identities.save!.mockImplementation((x: DiscordIdentity) =>
        Promise.resolve({ ...x, id: 'i' }),
      );
      members.findOne!.mockResolvedValue(null);
      regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });

      await svc.signInWithDiscord('code', null);
      expect(discord.isMemberOfGuild).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentUser', () => {
    it('returns the member projection when the user is enrolled', async () => {
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        name: 'Lord Commander',
        role: MemberRole.Owner,
        discordLinked: true,
        avatarUrl: 'https://cdn/a.png',
        rank: { name: 'General' },
      });
      authz.grantedCapabilities.mockResolvedValue(['manage_settings', 'view_audit_log']);
      const user: AuthenticatedUser = {
        identityId: 'identity-1',
        memberId: 'member-1',
        discordUserId: 'd',
        role: MemberRole.Owner,
        regimentId: 'regiment-1',
      };

      await expect(service.getCurrentUser(user)).resolves.toEqual({
        id: 'member-1',
        name: 'Lord Commander',
        rank: 'General',
        role: MemberRole.Owner,
        discordTag: null,
        discordLinked: true,
        avatarUrl: 'https://cdn/a.png',
        isMember: true,
        capabilities: ['manage_settings', 'view_audit_log'],
      });
      // Capabilities are resolved for the member's current role in their regiment.
      expect(authz.grantedCapabilities).toHaveBeenCalledWith('regiment-1', MemberRole.Owner);
    });

    it('returns the identity projection when there is no linked member', async () => {
      identities.findOne!.mockResolvedValue({
        id: 'identity-1',
        globalName: 'New Bie',
        discordTag: '@newbie',
        avatarUrl: 'https://cdn/a.png',
      });
      authz.grantedCapabilities.mockResolvedValue(['apply_to_join']);
      const user: AuthenticatedUser = {
        identityId: 'identity-1',
        memberId: null,
        discordUserId: 'd',
        role: MemberRole.Applicant,
        regimentId: 'regiment-1',
      };

      await expect(service.getCurrentUser(user)).resolves.toEqual({
        id: 'identity-1',
        name: 'New Bie',
        rank: null,
        role: MemberRole.Applicant,
        discordTag: '@newbie',
        discordLinked: false,
        avatarUrl: 'https://cdn/a.png',
        isMember: false,
        capabilities: ['apply_to_join'],
      });
      // Identity-only sessions resolve capabilities as an Applicant.
      expect(authz.grantedCapabilities).toHaveBeenCalledWith('regiment-1', MemberRole.Applicant);
    });
  });
});
