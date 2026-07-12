import { DataSource } from 'typeorm';
import { Seeder } from 'typeorm-extension';
import { seedAccentTones } from './accent-tones.seed';
import { seedAuditActions } from './audit-actions.seed';
import { seedDevOwner } from './dev-owner.seed';
import { seedDiscordBotSettings } from './discord-bot-settings.seed';
import { seedMedals } from './medals.seed';
import { seedRanks } from './ranks.seed';
import { seedRegiment } from './regiment.seed';
import { seedRolePermissions } from './role-permissions.seed';

/**
 * Orchestrates all seeders in dependency order. This is the only file matching
 * the seed runner's `*.seeder.ts` glob; the per-domain `*.seed.ts` helpers are
 * invoked from here so ordering is deterministic.
 */
export default class MainSeeder implements Seeder {
  async run(dataSource: DataSource): Promise<void> {
    await seedAccentTones(dataSource);
    await seedRegiment(dataSource);
    await seedRanks(dataSource);
    await seedMedals(dataSource);
    await seedRolePermissions(dataSource);
    await seedAuditActions(dataSource);
    await seedDiscordBotSettings(dataSource);
    await seedDevOwner(dataSource);
  }
}
