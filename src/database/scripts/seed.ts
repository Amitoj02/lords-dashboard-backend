import 'reflect-metadata';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';
import { runSeeders } from 'typeorm-extension';
import dataSource from '../data-source';

loadEnv();

/**
 * Initializes the DataSource and runs every registered seeder.
 * Seeders are designed to be idempotent (upsert by natural key) so this can be
 * re-run safely against an existing database.
 *
 *   npm run seed
 */
async function seed(): Promise<void> {
  await dataSource.initialize();
  try {
    // typeorm-extension's glob matcher needs forward slashes — normalize so it
    // works on Windows (path.join yields backslashes that match nothing).
    const toGlob = (...parts: string[]) => join(...parts).replace(/\\/g, '/');
    await runSeeders(dataSource, {
      seeds: [toGlob(__dirname, '..', 'seeds', '*.seeder.{ts,js}')],
      factories: [toGlob(__dirname, '..', 'factories', '*.factory.{ts,js}')],
    });

    console.log('✓ Seeding complete');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((err: unknown) => {
  console.error('✗ Seeding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
