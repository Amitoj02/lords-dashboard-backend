import { DataSource } from 'typeorm';
import { seedAccentTones } from './accent-tones.seed';
import { seedAuditActions } from './audit-actions.seed';
import { seedDevOwner } from './dev-owner.seed';
import { seedDiscordBotSettings } from './discord-bot-settings.seed';
import MainSeeder from './main.seeder';
import { seedMedals } from './medals.seed';
import { seedRanks } from './ranks.seed';
import { seedRegiment } from './regiment.seed';
import { seedRolePermissions } from './role-permissions.seed';

jest.mock('./accent-tones.seed', () => ({ seedAccentTones: jest.fn() }));
jest.mock('./audit-actions.seed', () => ({ seedAuditActions: jest.fn() }));
jest.mock('./dev-owner.seed', () => ({ seedDevOwner: jest.fn() }));
jest.mock('./discord-bot-settings.seed', () => ({ seedDiscordBotSettings: jest.fn() }));
jest.mock('./medals.seed', () => ({ seedMedals: jest.fn() }));
jest.mock('./ranks.seed', () => ({ seedRanks: jest.fn() }));
jest.mock('./regiment.seed', () => ({ seedRegiment: jest.fn() }));
jest.mock('./role-permissions.seed', () => ({ seedRolePermissions: jest.fn() }));

/**
 * `seed:prod` runs on EVERY deploy, chained after migrations by the compose
 * `migrate` one-shot. These tests pin the two-tier split that makes that safe.
 *
 * Before the split, a second deploy re-applied every hardcoded default over live
 * data: it reset `setupComplete`, overwrote the regiment name and mission
 * statement, unlinked every rank and medal from its real Discord role, flipped
 * `botEnabled` back off, reset the permission matrix, and nulled the Owner's
 * Discord profile and `lastSeenAt`. Nothing failed loudly — the configuration
 * simply reverted.
 */
describe('MainSeeder', () => {
  const greenfieldSeeders = [
    { name: 'regiment', fn: seedRegiment },
    { name: 'ranks', fn: seedRanks },
    { name: 'medals', fn: seedMedals },
    { name: 'discord bot settings', fn: seedDiscordBotSettings },
    { name: 'owner', fn: seedDevOwner },
  ];

  /** A DataSource whose Regiment repository reports the row present or absent. */
  const dataSourceWithRegiment = (exists: boolean): DataSource =>
    ({
      getRepository: () => ({ existsBy: jest.fn().mockResolvedValue(exists) }),
    }) as unknown as DataSource;

  beforeEach(() => jest.clearAllMocks());

  describe('on a greenfield database (no regiment row)', () => {
    it('provisions every tier-2 seeder', async () => {
      await new MainSeeder().run(dataSourceWithRegiment(false));

      for (const { fn } of greenfieldSeeders) {
        expect(fn).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('on an already-provisioned database (redeploy)', () => {
    it.each(greenfieldSeeders)(
      "does NOT re-run the $name seeder over the admin's live data",
      async ({ fn }) => {
        await new MainSeeder().run(dataSourceWithRegiment(true));

        expect(fn).not.toHaveBeenCalled();
      },
    );

    it('still refreshes the code-owned reference catalogs', async () => {
      // These are keyed on immutable code-level keys and the seed file is their
      // source of truth, so a tone or audit action added in a release must land.
      await new MainSeeder().run(dataSourceWithRegiment(true));

      expect(seedAccentTones).toHaveBeenCalledTimes(1);
      expect(seedAuditActions).toHaveBeenCalledTimes(1);
    });

    it('still runs role permissions, to back-fill newly added capabilities', async () => {
      // Insert-only per (role, capability), so this back-fills a capability
      // introduced since provisioning without touching the admin's edits.
      await new MainSeeder().run(dataSourceWithRegiment(true));

      expect(seedRolePermissions).toHaveBeenCalledTimes(1);
    });
  });
});
