import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { DiscordRolePolicyService, PRIVILEGED_ROLE_WARNING } from './discord-role-policy.service';
import type { DiscordGateway, DiscordRole } from './gateway/discord-gateway';

/**
 * LDA-H1: a rank/medal (or the join/ban settings) must only ever bind to a Discord
 * role the bot may safely assign — in-guild, below the bot, unmanaged, and
 * unprivileged. This is the control that severs web-app-staff → Discord-authority.
 *
 * T-0189 split that into two verdicts. The three "the bot cannot assign this at
 * all" checks still throw from both entry points. The privileged check is now
 * ADVISORY on `checkRoleLinkable` (what ranks/medals call) and still fatal on
 * `assertRoleLinkable` (what the join/Ban role settings call).
 */
describe('DiscordRolePolicyService (LDA-H1)', () => {
  const role = (over: Partial<DiscordRole> = {}): DiscordRole => ({
    id: '900000000000000010',
    name: 'Grunt',
    position: 5,
    permissions: '0',
    managed: false,
    ...over,
  });

  const build = (opts: {
    botMock: boolean;
    connected?: boolean;
    botRolePosition?: number | null;
    roles?: DiscordRole[];
  }) => {
    const gateway = {
      getStatus: jest.fn().mockResolvedValue({
        connected: opts.connected ?? true,
        botRolePosition: opts.botRolePosition ?? 20,
      }),
      listRoles: jest.fn().mockResolvedValue(opts.roles ?? [role()]),
    } as unknown as DiscordGateway;
    const config = {
      get: () => ({ botMock: opts.botMock }),
    } as unknown as ConfigService<AppConfig, true>;
    return new DiscordRolePolicyService(gateway, config);
  };

  describe('assertRoleLinkable', () => {
    it('is a no-op while the bot is mocked (validation deferred, H1 latent)', async () => {
      const svc = build({ botMock: true, roles: [role({ permissions: '8' })] });
      await expect(svc.assertRoleLinkable('999999999999999999')).resolves.toBeUndefined();
    });

    it('rejects when the bot is not connected (cannot validate → fail closed)', async () => {
      const svc = build({ botMock: false, connected: false });
      await expect(svc.assertRoleLinkable('900000000000000010')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('rejects a role that is not in the guild', async () => {
      const svc = build({ botMock: false, roles: [role({ id: '900000000000000010' })] });
      await expect(svc.assertRoleLinkable('111111111111111111')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a role at or above the bot in the hierarchy', async () => {
      const svc = build({
        botMock: false,
        botRolePosition: 10,
        roles: [role({ id: '900000000000000010', position: 10 })],
      });
      await expect(svc.assertRoleLinkable('900000000000000010')).rejects.toThrow(/hierarchy/i);
    });

    it('rejects an integration-managed role', async () => {
      const svc = build({
        botMock: false,
        roles: [role({ id: '900000000000000010', managed: true })],
      });
      await expect(svc.assertRoleLinkable('900000000000000010')).rejects.toThrow(/managed/i);
    });

    it('STILL rejects a privileged role (the join/Ban settings have no admin in the loop)', async () => {
      // 1 << 2 = 4 = BAN_MEMBERS
      const svc = build({
        botMock: false,
        roles: [role({ id: '900000000000000010', permissions: '4' })],
      });
      await expect(svc.assertRoleLinkable('900000000000000010')).rejects.toThrow(/privileged/i);
    });

    it('accepts a clean, below-bot, unmanaged, unprivileged role', async () => {
      const svc = build({ botMock: false, roles: [role({ id: '900000000000000010' })] });
      await expect(svc.assertRoleLinkable('900000000000000010')).resolves.toBeUndefined();
    });
  });

  describe('checkRoleLinkable (rank/medal path — T-0189)', () => {
    it('is a no-op while the bot is mocked (validation deferred, H1 latent)', async () => {
      const svc = build({ botMock: true, roles: [role({ permissions: '8' })] });
      await expect(svc.checkRoleLinkable('999999999999999999')).resolves.toBeNull();
    });

    it('WARNS instead of throwing for a privileged role, naming the consequence', async () => {
      // 1 << 3 = 8 = ADMINISTRATOR
      const svc = build({
        botMock: false,
        roles: [role({ id: '900000000000000010', permissions: '8' })],
      });
      const warning = await svc.checkRoleLinkable('900000000000000010');
      expect(warning).toBe(PRIVILEGED_ROLE_WARNING);
      expect(warning).toMatch(/privileged/i);
    });

    it('returns null for a clean role', async () => {
      const svc = build({ botMock: false, roles: [role({ id: '900000000000000010' })] });
      await expect(svc.checkRoleLinkable('900000000000000010')).resolves.toBeNull();
    });

    // The three below are NOT judgement calls: the bot physically cannot assign
    // these, so letting the link through would only bank a mapping that fails
    // later, once per holder, in a background job nobody is watching.
    it('still throws for a role that is not in the guild', async () => {
      const svc = build({ botMock: false, roles: [role({ id: '900000000000000010' })] });
      await expect(svc.checkRoleLinkable('111111111111111111')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('still throws for a role at or above the bot in the hierarchy', async () => {
      const svc = build({
        botMock: false,
        botRolePosition: 10,
        roles: [role({ id: '900000000000000010', position: 10 })],
      });
      await expect(svc.checkRoleLinkable('900000000000000010')).rejects.toThrow(/hierarchy/i);
    });

    it('still throws for an integration-managed role', async () => {
      const svc = build({
        botMock: false,
        roles: [role({ id: '900000000000000010', managed: true })],
      });
      await expect(svc.checkRoleLinkable('900000000000000010')).rejects.toThrow(/managed/i);
    });

    it('still fails closed when the bot is not connected', async () => {
      const svc = build({ botMock: false, connected: false });
      await expect(svc.checkRoleLinkable('900000000000000010')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('holdsPrivilegedPermissions', () => {
    it('flags ADMINISTRATOR (8)', () => {
      expect(DiscordRolePolicyService.holdsPrivilegedPermissions('8')).toBe(true);
    });
    it('flags MODERATE_MEMBERS (1 << 40)', () => {
      expect(DiscordRolePolicyService.holdsPrivilegedPermissions((1n << 40n).toString())).toBe(
        true,
      );
    });
    it('does not flag a benign permission (VIEW_CHANNEL, 1 << 10)', () => {
      expect(DiscordRolePolicyService.holdsPrivilegedPermissions((1n << 10n).toString())).toBe(
        false,
      );
    });
    it('does not flag no permissions', () => {
      expect(DiscordRolePolicyService.holdsPrivilegedPermissions('0')).toBe(false);
    });
    it('treats an unparseable bitfield as privileged (fail closed)', () => {
      expect(DiscordRolePolicyService.holdsPrivilegedPermissions('not-a-number')).toBe(true);
    });
  });
});
