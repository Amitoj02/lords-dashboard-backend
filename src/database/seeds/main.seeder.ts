import { DataSource } from 'typeorm';
import { Seeder } from 'typeorm-extension';
import { Regiment } from '../../regiments/entities/regiment.entity';
import { seedAccentTones } from './accent-tones.seed';
import { seedAuditActions } from './audit-actions.seed';
import { seedDevOwner } from './dev-owner.seed';
import { seedDiscordBotSettings } from './discord-bot-settings.seed';
import { seedMedals } from './medals.seed';
import { seedRanks } from './ranks.seed';
import { seedRegiment } from './regiment.seed';
import { seedRolePermissions } from './role-permissions.seed';
import { REGIMENT_ID } from './seed.util';

/**
 * Orchestrates all seeders in dependency order. This is the only file matching
 * the seed runner's `*.seeder.ts` glob; the per-domain `*.seed.ts` helpers are
 * invoked from here so ordering is deterministic.
 *
 * ─── Why this is split into two tiers ────────────────────────────────────────
 * `seed:prod` runs on EVERY deploy (the compose `migrate` one-shot chains
 * `migration:run:prod && seed:prod`), so "the seeders are idempotent" is not on
 * its own enough — re-applying a hardcoded default to a row an admin has since
 * edited is idempotent AND destructive. Left unsplit, the second deploy would
 * have reset `setupComplete`, overwritten the regiment name and mission
 * statement, unlinked every rank and medal from its real Discord role
 * (`linked: false`), flipped `botEnabled` back off, reset the whole permission
 * matrix, and nulled the Owner's Discord profile and `lastSeenAt`.
 *
 * TIER 1 — code-owned reference catalogs. The seed file IS the source of truth,
 * keys are immutable, and refreshing on every deploy is the desired behaviour
 * (a new accent tone or audit action ships with the release that adds it).
 *
 * TIER 2 — greenfield provisioning. These tables are handed to the admin the
 * moment the regiment exists. They are written once, on an empty database, and
 * never touched again. Changing a default here only affects NEW deployments;
 * to change an existing one, write a migration.
 *
 * The exception is role permissions, which sit in tier 1 but provision row by
 * row: `role` and `capability` are enum values (immutable), so a capability
 * added in a later release still gets its default grant on an existing
 * deployment, while an admin's edits to existing rows survive untouched.
 */
export default class MainSeeder implements Seeder {
  async run(dataSource: DataSource): Promise<void> {
    // ── Tier 1: always ────────────────────────────────────────────────────
    await seedAccentTones(dataSource);
    await seedAuditActions(dataSource);

    // ── Tier 2: greenfield only ───────────────────────────────────────────
    // The regiment row is the marker. If it exists this database has been
    // provisioned and is now owned by the admin, so nothing below runs.
    const provisioned = await dataSource.getRepository(Regiment).existsBy({ id: REGIMENT_ID });

    if (provisioned) {
      console.log('• Regiment already provisioned — skipping greenfield seeders');
    } else {
      await seedRegiment(dataSource);
      await seedRanks(dataSource);
      await seedMedals(dataSource);
      await seedDiscordBotSettings(dataSource);
      await seedDevOwner(dataSource);
    }

    // Runs in both cases: needs the regiment to exist, and back-fills the
    // default grant for any capability introduced since this database was
    // provisioned. Never overwrites an existing row.
    await seedRolePermissions(dataSource);
  }
}
