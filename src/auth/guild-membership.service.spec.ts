import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AuthzService } from '../authz/authz.service';
import { MemberRole } from '../common/enums';
import { AppConfig } from '../config/configuration';
import { DiscordBotSettings } from '../discord/entities/discord-bot-settings.entity';
import {
  DiscordGateway,
  MemberJoinHandler,
  MemberLeaveHandler,
} from '../discord/gateway/discord-gateway';
import { DiscordIdentity } from './entities/discord-identity.entity';
import { GuildMembershipService } from './guild-membership.service';
import { AuthenticatedUser } from './types/authenticated-user.interface';

const IDENTITY_ID = 'identity-1';
const DISCORD_ID = '999000111222';

const user = (): AuthenticatedUser => ({
  identityId: IDENTITY_ID,
  memberId: 'member-1',
  discordUserId: DISCORD_ID,
  role: MemberRole.Member,
  regimentId: 'regiment-1',
});

/** A stored identity row, defaulting to "never confirmed either way". */
const row = (over: Partial<DiscordIdentity> = {}): Partial<DiscordIdentity> => ({
  id: IDENTITY_ID,
  discordUserId: DISCORD_ID,
  guildMember: false,
  guildCheckedAt: null,
  ...over,
});

describe('GuildMembershipService', () => {
  let service: GuildMembershipService;
  let identities: { findOne: jest.Mock; update: jest.Mock };
  let settings: { findOne: jest.Mock };
  let gateway: {
    fetchMember: jest.Mock;
    registerMemberJoinHandler: jest.Mock;
    registerMemberLeaveHandler: jest.Mock;
  };
  let authz: { can: jest.Mock };
  let joinHandler: MemberJoinHandler;
  let leaveHandler: MemberLeaveHandler;

  const build = (guildId = 'guild-1'): GuildMembershipService =>
    new GuildMembershipService(
      identities as unknown as Repository<DiscordIdentity>,
      settings as unknown as Repository<DiscordBotSettings>,
      gateway as unknown as DiscordGateway,
      { get: jest.fn().mockReturnValue({ guildId }) } as unknown as ConfigService<AppConfig, true>,
      authz as unknown as AuthzService,
    );

  beforeEach(() => {
    identities = {
      findOne: jest.fn().mockResolvedValue(row()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    settings = { findOne: jest.fn().mockResolvedValue(null) };
    gateway = {
      // Non-null ⇒ in the guild.
      fetchMember: jest.fn().mockResolvedValue({ id: DISCORD_ID, roles: [], joinedAt: null }),
      registerMemberJoinHandler: jest.fn((h: MemberJoinHandler) => (joinHandler = h)),
      registerMemberLeaveHandler: jest.fn((h: MemberLeaveHandler) => (leaveHandler = h)),
    };
    authz = { can: jest.fn().mockResolvedValue(false) };
    service = build();
  });

  describe('verdictOf (the read path used by /auth/me)', () => {
    it('treats a never-confirmed identity as a member, because the check FAILS OPEN (T-0168)', () => {
      // Every row in production starts here on the deploy that adds the column.
      // Reading that as "not a member" would gate the entire regiment out at once.
      expect(GuildMembershipService.verdictOf(row() as DiscordIdentity)).toEqual({
        guildMember: true,
        checkedAt: null,
        degraded: true,
      });
    });

    it('reports a CONFIRMED negative verdict as such, not as degraded', () => {
      const checkedAt = new Date('2026-07-22T10:00:00.000Z');
      expect(
        GuildMembershipService.verdictOf(
          row({ guildMember: false, guildCheckedAt: checkedAt }) as DiscordIdentity,
        ),
      ).toEqual({ guildMember: false, checkedAt, degraded: false });
    });
  });

  describe('resolve', () => {
    it('asks the bot once and serves the cached verdict for the rest of the TTL', async () => {
      await expect(service.resolve(IDENTITY_ID)).resolves.toMatchObject({
        guildMember: true,
        degraded: false,
      });
      await service.resolve(IDENTITY_ID);
      await service.resolve(IDENTITY_ID);

      expect(gateway.fetchMember).toHaveBeenCalledTimes(1);
    });

    it('re-checks after the cached verdict is dropped', async () => {
      await service.resolve(IDENTITY_ID);
      service.invalidate(IDENTITY_ID);
      await service.resolve(IDENTITY_ID);

      expect(gateway.fetchMember).toHaveBeenCalledTimes(2);
    });

    it('collapses concurrent lookups for one identity into a single bot call', async () => {
      // Five tabs opening at once must cost the bot one call, not five.
      let release!: (value: null) => void;
      gateway.fetchMember.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const pending = [1, 2, 3, 4, 5].map(() => service.resolve(IDENTITY_ID));
      release(null);
      const verdicts = await Promise.all(pending);

      expect(gateway.fetchMember).toHaveBeenCalledTimes(1);
      expect(verdicts.every((v) => v.guildMember === false)).toBe(true);
    });

    it('persists the confirmed verdict together with its check stamp', async () => {
      await service.resolve(IDENTITY_ID);

      expect(identities.update).toHaveBeenCalledWith(
        { id: IDENTITY_ID },
        expect.objectContaining({ guildMember: true, guildCheckedAt: expect.any(Date) }),
      );
    });

    it('KEEPS the last known verdict when the bot cannot answer, and writes nothing', async () => {
      const checkedAt = new Date('2026-07-20T00:00:00.000Z');
      identities.findOne.mockResolvedValue(row({ guildMember: true, guildCheckedAt: checkedAt }));
      gateway.fetchMember.mockRejectedValue(new Error('Discord bot is not connected'));

      await expect(service.resolve(IDENTITY_ID)).resolves.toEqual({
        guildMember: true,
        checkedAt,
        degraded: true,
      });
      // A failed lookup is not evidence of anything — it must not become one.
      expect(identities.update).not.toHaveBeenCalled();
    });

    it('does NOT let a bot outage turn a confirmed member into a non-member', async () => {
      // The distinction this pins: "could not check" must never masquerade as a
      // negative verdict, which is exactly what the old fail-closed code did.
      identities.findOne.mockResolvedValue(
        row({ guildMember: true, guildCheckedAt: new Date('2026-07-20T00:00:00.000Z') }),
      );
      gateway.fetchMember.mockRejectedValue(new Error('boom'));

      const verdict = await service.resolve(IDENTITY_ID);

      expect(verdict.guildMember).toBe(true);
      expect(verdict.degraded).toBe(true);
    });

    it('reports a member when there has never been a verdict AND the bot is down', async () => {
      gateway.fetchMember.mockRejectedValue(new Error('boom'));

      await expect(service.resolve(IDENTITY_ID)).resolves.toEqual({
        guildMember: true,
        checkedAt: null,
        degraded: true,
      });
    });
  });

  describe('probe', () => {
    it('returns null (not false) when no guild is configured — an absent verdict, not a negative one', async () => {
      const svc = build('');
      await expect(svc.probe(DISCORD_ID)).resolves.toBeNull();
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('returns null rather than hanging when the bot never answers', async () => {
      jest.useFakeTimers();
      try {
        gateway.fetchMember.mockReturnValue(new Promise<never>(() => {}));
        const pending = service.probe(DISCORD_ID);
        // Past GUILD_LOOKUP_TIMEOUT_MS (4000ms): sign-in runs one of these
        // inline, so an unbounded wait would be an unbounded login.
        await jest.advanceTimersByTimeAsync(4000);
        await expect(pending).resolves.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('opens the breaker after repeated failures, then half-opens for a single probe', async () => {
      jest.useFakeTimers();
      try {
        gateway.fetchMember.mockRejectedValue(new Error('not connected'));

        for (let i = 0; i < 5; i++) await service.probe(DISCORD_ID);
        // Three strikes, then no more calls at all — the point of the breaker is
        // that a disconnected bot stops costing 4s per sign-in.
        expect(gateway.fetchMember).toHaveBeenCalledTimes(3);

        // Half-open: exactly one probe is let through after the cooldown.
        await jest.advanceTimersByTimeAsync(60_000);
        await service.probe(DISCORD_ID);
        expect(gateway.fetchMember).toHaveBeenCalledTimes(4);
        await service.probe(DISCORD_ID);
        expect(gateway.fetchMember).toHaveBeenCalledTimes(4);

        // A successful half-open probe closes the breaker again.
        await jest.advanceTimersByTimeAsync(60_000);
        gateway.fetchMember.mockResolvedValue({ id: DISCORD_ID, roles: [], joinedAt: null });
        await expect(service.probe(DISCORD_ID)).resolves.toBe(true);
        await expect(service.probe(DISCORD_ID)).resolves.toBe(true);
        expect(gateway.fetchMember).toHaveBeenCalledTimes(6);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('getStatus', () => {
    it('reports the gate as off when the regiment has no bot settings row yet', async () => {
      await expect(service.getStatus(user())).resolves.toMatchObject({
        gateEnabled: false,
        exempt: false,
        guildMember: true,
        degraded: false,
      });
    });

    it('exempts manage_settings holders so a misconfiguration cannot lock them out', async () => {
      settings.findOne.mockResolvedValue({ guildGateEnabled: true });
      authz.can.mockResolvedValue(true);
      gateway.fetchMember.mockResolvedValue(null);

      const status = await service.getStatus(user());

      // Exempt callers are never gated — but their membership is still reported
      // honestly, so the settings screen can show them the real state.
      expect(status).toMatchObject({ gateEnabled: true, exempt: true, guildMember: false });
      expect(status.checkedAt).toEqual(expect.any(String));
    });
  });

  describe('live guild events (T-0169)', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

    it('flips the stored verdict to false the moment a member leaves', async () => {
      await leaveHandler(DISCORD_ID);

      expect(identities.update).toHaveBeenCalledWith(
        { id: IDENTITY_ID },
        expect.objectContaining({ guildMember: false, guildCheckedAt: expect.any(Date) }),
      );
    });

    it('serves the departure verdict without another bot call, so the gate bites on the next visit', async () => {
      await leaveHandler(DISCORD_ID);

      await expect(service.resolve(IDENTITY_ID)).resolves.toMatchObject({
        guildMember: false,
        degraded: false,
      });
      // Discord just told us; re-deriving it from the bot would be pointless.
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('clears the gate again on re-join without waiting for the TTL', async () => {
      await leaveHandler(DISCORD_ID);
      await joinHandler(DISCORD_ID);

      await expect(service.resolve(IDENTITY_ID)).resolves.toMatchObject({ guildMember: true });
      expect(gateway.fetchMember).not.toHaveBeenCalled();
    });

    it('ignores an event for a Discord user with no identity row, without throwing', async () => {
      // Someone who joined the server but has never signed in: there is nothing
      // to record against, and throwing would surface inside discord.js.
      identities.findOne.mockResolvedValue(null);

      await expect(leaveHandler('123456789012345678')).resolves.toBeUndefined();
      expect(identities.update).not.toHaveBeenCalled();
    });
  });
});
