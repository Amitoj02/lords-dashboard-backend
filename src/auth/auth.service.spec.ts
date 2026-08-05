import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberRole, MemberStatus } from '../common/enums';
import { DiscordBotSettings } from '../discord/entities/discord-bot-settings.entity';
import { DiscordGateway } from '../discord/gateway/discord-gateway';
import { Member } from '../members/entities/member.entity';
import { Regiment } from '../regiments/entities/regiment.entity';
import { AuthzService } from '../authz/authz.service';
import { AuthService } from './auth.service';
import { DiscordOAuthService } from './discord-oauth.service';
import { GuildMembershipService } from './guild-membership.service';
import { SessionContextService } from './session-context.service';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { AuthenticatedUser } from './types/authenticated-user.interface';
import { JwtPayload } from './types/jwt-payload.interface';

type MockRepo<T extends object> = Partial<Record<keyof Repository<T>, jest.Mock>>;
const repoMock = <T extends object>(): MockRepo<T> => ({
  findOne: jest.fn(),
  create: jest.fn((x: unknown) => x),
  save: jest.fn((x: unknown) => Promise.resolve(x)),
  update: jest.fn(() => Promise.resolve({ affected: 1 })),
});

const TOKEN = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  token_type: 'Bearer',
  expires_in: 604800,
  scope: 'identify email',
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
  let botSettings: MockRepo<DiscordBotSettings>;
  let discord: jest.Mocked<
    Pick<DiscordOAuthService, 'exchangeCode' | 'fetchUser' | 'buildAvatarUrl'>
  >;
  let gateway: {
    fetchMember: jest.Mock;
    registerMemberJoinHandler: jest.Mock;
    registerMemberLeaveHandler: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock };
  let authz: { grantedCapabilities: jest.Mock; can: jest.Mock };
  let sessionContext: { invalidate: jest.Mock; invalidateSessions: jest.Mock };

  beforeEach(async () => {
    identities = repoMock<DiscordIdentity>();
    members = repoMock<Member>();
    regiments = repoMock<Regiment>();
    botSettings = repoMock<DiscordBotSettings>();
    authz = {
      grantedCapabilities: jest.fn().mockResolvedValue([]),
      can: jest.fn().mockResolvedValue(false),
    };
    sessionContext = { invalidate: jest.fn(), invalidateSessions: jest.fn() };
    discord = {
      exchangeCode: jest.fn().mockResolvedValue(TOKEN),
      fetchUser: jest.fn().mockResolvedValue(NEW_PROFILE),
      buildAvatarUrl: jest.fn().mockReturnValue('https://cdn/avatar.png'),
    };
    // Guild membership is now resolved from the bot gateway (T-0050): a non-null
    // fetchMember means the user is in the guild.
    gateway = {
      fetchMember: jest.fn().mockResolvedValue({ id: NEW_PROFILE.id, roles: [], joinedAt: null }),
      registerMemberJoinHandler: jest.fn(),
      registerMemberLeaveHandler: jest.fn(),
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        // The REAL GuildMembershipService, not a stub: the bot-lookup semantics
        // under test (timeout, fail-open, breaker) live in it, and asserting
        // them through `gateway.fetchMember` is what pins the actual behaviour.
        GuildMembershipService,
        { provide: getRepositoryToken(DiscordIdentity), useValue: identities },
        { provide: getRepositoryToken(Member), useValue: members },
        { provide: getRepositoryToken(Regiment), useValue: regiments },
        { provide: getRepositoryToken(DiscordBotSettings), useValue: botSettings },
        { provide: DiscordOAuthService, useValue: discord },
        { provide: DiscordGateway, useValue: gateway },
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
      // guildMember is derived from the bot gateway (T-0050), keyed by the Discord
      // user id — NOT from the OAuth `guilds` scope.
      expect(gateway.fetchMember).toHaveBeenCalledWith('999000111222');

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

    it('does not query the bot for guild membership when no guild is configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuthService,
          GuildMembershipService,
          { provide: getRepositoryToken(DiscordIdentity), useValue: identities },
          { provide: getRepositoryToken(Member), useValue: members },
          { provide: getRepositoryToken(Regiment), useValue: regiments },
          { provide: getRepositoryToken(DiscordBotSettings), useValue: botSettings },
          { provide: DiscordOAuthService, useValue: discord },
          { provide: DiscordGateway, useValue: gateway },
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
      expect(gateway.fetchMember).not.toHaveBeenCalled();
      const saved = identities.save!.mock.calls[0][0] as DiscordIdentity;
      // Nothing to check against, so nothing is CONFIRMED: a brand-new identity
      // is seeded false but carries no check stamp (T-0168).
      expect(saved.guildMember).toBe(false);
      expect(saved.guildCheckedAt).toBeUndefined();
    });

    it('records guildMember=false when the bot does not find the user in the guild', async () => {
      identities.findOne!.mockResolvedValue(null);
      identities.save!.mockImplementation((x: DiscordIdentity) =>
        Promise.resolve({ ...x, id: 'i' }),
      );
      members.findOne!.mockResolvedValue(null);
      regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });
      // The bot reports the user is NOT in the guild.
      gateway.fetchMember.mockResolvedValue(null);

      await service.signInWithDiscord('code', null);

      const saved = identities.save!.mock.calls[0][0] as DiscordIdentity;
      expect(saved.guildMember).toBe(false);
      // A CONFIRMED "not a member" is stamped, which is what distinguishes it
      // from "we could not check" (T-0168).
      expect(saved.guildCheckedAt).toBeInstanceOf(Date);
    });

    it('never blocks login when the bot lookup throws — seeds a new identity false without stamping it (T-0168)', async () => {
      identities.findOne!.mockResolvedValue(null);
      identities.save!.mockImplementation((x: DiscordIdentity) =>
        Promise.resolve({ ...x, id: 'i' }),
      );
      members.findOne!.mockResolvedValue(null);
      regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });
      // A disconnected/slow bot surfaces as a thrown error; login must still succeed.
      gateway.fetchMember.mockRejectedValue(new Error('gateway not connected'));

      const result = await service.signInWithDiscord('code', null);

      expect(result.token).toBe('signed.jwt.token');
      const saved = identities.save!.mock.calls[0][0] as DiscordIdentity;
      expect(saved.guildMember).toBe(false);
      // Unconfirmed, so no stamp — the verdict is explicitly "unknown", which is
      // what makes the read path fail open instead of denying.
      expect(saved.guildCheckedAt).toBeUndefined();
    });

    it('does NOT overwrite an existing true verdict when the bot lookup fails (T-0168)', async () => {
      // The failure this pins: an established member signs in during a bot
      // outage. Writing the old fail-closed `false` would have stripped their
      // membership and — once the gate is on — locked them out until someone
      // noticed. A lookup that did not complete must write nothing.
      const stamped = new Date('2026-07-01T00:00:00.000Z');
      identities.findOne!.mockResolvedValue({
        id: 'identity-established',
        discordUserId: NEW_PROFILE.id,
        guildMember: true,
        guildCheckedAt: stamped,
      });
      identities.save!.mockImplementation((x: DiscordIdentity) => Promise.resolve(x));
      members.findOne!.mockResolvedValue(null);
      regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });
      gateway.fetchMember.mockRejectedValue(new Error('Discord bot is not connected'));

      await service.signInWithDiscord('code', null);

      const saved = identities.save!.mock.calls[0][0] as DiscordIdentity;
      expect(saved.guildMember).toBe(true);
      expect(saved.guildCheckedAt).toBe(stamped);
    });

    it('stops calling the bot after repeated failures, so login keeps its latency budget (T-0168)', async () => {
      identities.findOne!.mockResolvedValue(null);
      identities.save!.mockImplementation((x: DiscordIdentity) =>
        Promise.resolve({ ...x, id: 'i' }),
      );
      members.findOne!.mockResolvedValue(null);
      regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });
      gateway.fetchMember.mockRejectedValue(new Error('Discord bot is not connected'));

      for (let i = 0; i < 5; i++) {
        await service.signInWithDiscord('code', null);
      }

      // Three consecutive failures trip the breaker; every later sign-in
      // short-circuits without touching Discord at all.
      expect(gateway.fetchMember).toHaveBeenCalledTimes(3);
    });

    it('never blocks login when the bot lookup HANGS — times out without a verdict (T-0168)', async () => {
      jest.useFakeTimers();
      try {
        identities.findOne!.mockResolvedValue(null);
        identities.save!.mockImplementation((x: DiscordIdentity) =>
          Promise.resolve({ ...x, id: 'i' }),
        );
        members.findOne!.mockResolvedValue(null);
        regiments.findOne!.mockResolvedValue({ id: 'regiment-1' });
        // A hung gateway call that never settles — the inline timeout must abandon it.
        gateway.fetchMember.mockReturnValue(new Promise<never>(() => {}));

        const pending = service.signInWithDiscord('code', null);
        // Advance past GUILD_LOOKUP_TIMEOUT_MS (4000ms) so withTimeout rejects.
        await jest.advanceTimersByTimeAsync(4000);
        const result = await pending;

        expect(result.token).toBe('signed.jwt.token');
        const saved = identities.save!.mock.calls[0][0] as DiscordIdentity;
        expect(saved.guildMember).toBe(false);
        expect(saved.guildCheckedAt).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('getCurrentUser', () => {
    it('returns the member projection when the user is enrolled', async () => {
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        inGameName: 'Lord Commander',
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
        inGameName: 'Lord Commander',
        // The caller's own vanity handle (T-0215). Null here because the member
        // fixture has not claimed one; the SPA needs it to route "my profile"
        // straight to /u/@handle rather than to the short-id URL.
        username: null,
        rank: 'General',
        role: MemberRole.Owner,
        discordTag: null,
        discordLinked: true,
        avatarUrl: 'https://cdn/a.png',
        isMember: true,
        capabilities: ['manage_settings', 'view_audit_log'],
        // The gate fields are always present (T-0166). This member's identity
        // has never been confirmed against the guild, so the verdict fails open.
        guildMember: true,
        discordInviteUrl: null,
        guildGateEnabled: false,
        guildGateExempt: false,
      });
      // Capabilities are resolved for the member's current role in their regiment.
      expect(authz.grantedCapabilities).toHaveBeenCalledWith('regiment-1', MemberRole.Owner);
    });

    it('falls back to the Discord avatar when the member has no custom avatar (T-0093)', async () => {
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        inGameName: 'Lord Commander',
        role: MemberRole.Owner,
        discordLinked: true,
        avatarUrl: null,
        discordIdentity: { avatarUrl: 'https://cdn/discord.png' },
        rank: { name: 'General' },
      });
      authz.grantedCapabilities.mockResolvedValue([]);
      const user: AuthenticatedUser = {
        identityId: 'identity-1',
        memberId: 'member-1',
        discordUserId: 'd',
        role: MemberRole.Owner,
        regimentId: 'regiment-1',
      };

      await expect(service.getCurrentUser(user)).resolves.toMatchObject({
        avatarUrl: 'https://cdn/discord.png',
      });
    });

    it('returns null avatar when neither custom nor Discord avatar exists (T-0093)', async () => {
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        inGameName: 'Lord Commander',
        role: MemberRole.Member,
        discordLinked: false,
        avatarUrl: null,
        discordIdentity: null,
        rank: null,
      });
      authz.grantedCapabilities.mockResolvedValue([]);
      const user: AuthenticatedUser = {
        identityId: 'identity-1',
        memberId: 'member-1',
        discordUserId: 'd',
        role: MemberRole.Member,
        regimentId: 'regiment-1',
      };

      await expect(service.getCurrentUser(user)).resolves.toMatchObject({ avatarUrl: null });
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
        inGameName: 'New Bie',
        // ALWAYS null on the identity-only projection (T-0215): a caller who is
        // not on the roster has no handle to claim yet, and the Discord username
        // is a different namespace entirely.
        username: null,
        rank: null,
        role: MemberRole.Applicant,
        discordTag: '@newbie',
        discordLinked: false,
        avatarUrl: 'https://cdn/a.png',
        isMember: false,
        capabilities: ['apply_to_join'],
        // Identity-only (Applicant) sessions carry the gate fields too (T-0166) —
        // an applicant is exactly who the invite prompt is for.
        guildMember: true,
        discordInviteUrl: null,
        guildGateEnabled: false,
        guildGateExempt: false,
      });
      // Identity-only sessions resolve capabilities as an Applicant.
      expect(authz.grantedCapabilities).toHaveBeenCalledWith('regiment-1', MemberRole.Applicant);
    });

    it('carries the guild gate, the invite and the exemption on the projection (T-0166)', async () => {
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        inGameName: 'Lord Commander',
        role: MemberRole.Owner,
        discordLinked: true,
        avatarUrl: null,
        rank: null,
        // A CONFIRMED "not in the guild" — stamped, so it is a real verdict.
        discordIdentity: {
          guildMember: false,
          guildCheckedAt: new Date('2026-07-22T10:00:00.000Z'),
        },
      });
      regiments.findOne!.mockResolvedValue({ discordInviteUrl: 'https://discord.gg/lords' });
      botSettings.findOne!.mockResolvedValue({ guildGateEnabled: true });
      authz.can.mockResolvedValue(true);

      const user: AuthenticatedUser = {
        identityId: 'identity-1',
        memberId: 'member-1',
        discordUserId: 'd',
        role: MemberRole.Owner,
        regimentId: 'regiment-1',
      };

      await expect(service.getCurrentUser(user)).resolves.toMatchObject({
        guildMember: false,
        // The invite is what turns the gate screen into a way back in.
        discordInviteUrl: 'https://discord.gg/lords',
        guildGateEnabled: true,
        guildGateExempt: true,
      });
      // Exemption is manage_settings, so a bad invite can never lock the people
      // who could fix it out of the settings screen.
      expect(authz.can).toHaveBeenCalledWith('regiment-1', MemberRole.Owner, 'manage_settings');
    });

    it('never asks the bot while projecting the session (T-0167)', async () => {
      members.findOne!.mockResolvedValue({
        id: 'member-1',
        inGameName: 'Lord Commander',
        role: MemberRole.Member,
        discordLinked: true,
        avatarUrl: null,
        rank: null,
        discordIdentity: { guildMember: true, guildCheckedAt: new Date() },
      });
      const user: AuthenticatedUser = {
        identityId: 'identity-1',
        memberId: 'member-1',
        discordUserId: 'd',
        role: MemberRole.Member,
        regimentId: 'regiment-1',
      };

      await service.getCurrentUser(user);

      // /auth/me is on the hot path of every page load; a Discord round-trip
      // there would put the bot's latency in front of the whole dashboard.
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });
  });
});
