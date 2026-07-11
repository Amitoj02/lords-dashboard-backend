import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import dataSource from '../data-source';
import MainSeeder from '../seeds/main.seeder';

loadEnv();

/**
 * Initializes the DataSource and runs every registered seeder.
 * Seeders are designed to be idempotent (upsert by natural key) so this can be
 * re-run safely against an existing database.
 *
 * MainSeeder is invoked directly rather than through typeorm-extension's
 * glob-based `runSeeders`, whose dynamic `import()` loader fails on `.ts`
 * seeders under ts-node/CommonJS ("Cannot use import statement outside a
 * module"). Direct invocation also keeps this runnable from compiled JS in the
 * slim production image (no ts-node), which the containerized deploy relies on.
 *
 *   npm run seed
 */
async function seed(): Promise<void> {
  await dataSource.initialize();
  try {
    await new MainSeeder().run(dataSource);
    console.log('✓ Seeding complete');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((err: unknown) => {
  console.error('✗ Seeding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
