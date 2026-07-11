import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { createConnection } from 'mysql2/promise';

loadEnv();

/**
 * Creates the application database if it does not already exist.
 * Connects to the MySQL server WITHOUT selecting a database, so it works against
 * a fresh MySQL 8 server (e.g. the compose `db` service). Idempotent — safe to
 * run repeatedly. In production the `db` container auto-creates the database from
 * MYSQL_DATABASE, so only migrate+seed run (see db:setup:prod).
 *
 *   npm run db:create
 */
async function createDatabase(): Promise<void> {
  const host = process.env.DB_HOST ?? 'localhost';
  const port = parseInt(process.env.DB_PORT ?? '3306', 10);
  const user = process.env.DB_USERNAME ?? 'root';
  const password = process.env.DB_PASSWORD ?? '';
  const database = process.env.DB_DATABASE ?? 'lords_dashboard';

  const connection = await createConnection({ host, port, user, password });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` ` +
        `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    console.log(`✓ Database "${database}" is ready on ${host}:${port}`);
  } finally {
    await connection.end();
  }
}

createDatabase().catch((err: unknown) => {
  console.error('✗ Failed to create database:', err instanceof Error ? err.message : err);
  process.exit(1);
});
