import { join } from 'path';
import { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

const bool = (v: string | undefined): boolean =>
  ['true', '1', 'yes', 'on'].includes((v ?? '').toLowerCase());

/**
 * Single source of truth for TypeORM connection options.
 * Shared by the Nest runtime (DatabaseModule) and the TypeORM CLI
 * (data-source.ts) so migrations and the app always agree on the schema.
 *
 * The `{ts,js}` globs resolve under both ts-node (CLI/dev) and compiled output.
 */
export function buildDataSourceOptions(
  env: NodeJS.ProcessEnv = process.env,
): MysqlConnectionOptions {
  return {
    type: 'mysql',
    host: env.DB_HOST ?? 'localhost',
    port: parseInt(env.DB_PORT ?? '3306', 10),
    username: env.DB_USERNAME ?? 'root',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_DATABASE ?? 'lords_dashboard',
    // Schema is owned exclusively by migrations — never auto-sync.
    synchronize: false,
    logging: bool(env.DB_LOGGING),
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    namingStrategy: new SnakeNamingStrategy(),
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'typeorm_migrations',
  };
}
