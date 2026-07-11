/**
 * Strongly-typed configuration assembled from validated environment variables.
 * Consume via `ConfigService<AppConfig, true>` for end-to-end type safety, e.g.
 *   configService.get('discord', { infer: true }).clientId
 */

const toBool = (value: string | boolean | undefined, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
};

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  database: DatabaseConfig;
  jwt: JwtConfig;
  discord: DiscordConfig;
  frontend: FrontendConfig;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  synchronize: boolean;
  logging: boolean;
}

export interface JwtConfig {
  secret: string;
  expiresIn: string;
  /** AES-256-GCM key (64 hex) for encrypting Discord tokens + event passwords at rest. */
  encryptionKey: string;
}

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string[];
  guildId: string;
  /**
   * When true, the real Discord OAuth2 network calls are replaced by an
   * in-process mock (see MockDiscordOAuthService) so the full sign-in → JWT →
   * /auth/me flow works with no Discord application. Flip to false and fill in
   * clientId/clientSecret to go live — nothing else changes.
   */
  mock: boolean;
  /** Persona the mock signs in as when no `?as=` hint is given (default `owner`). */
  mockDefaultPersona: string;
}

export interface FrontendConfig {
  url: string;
  authSuccessRedirect: string;
  authFailureRedirect: string;
}

export default (): AppConfig => ({
  env: (process.env.NODE_ENV as AppConfig['env']) ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigins: csv(process.env.CORS_ORIGINS) || ['http://localhost:4200'],
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    username: process.env.DB_USERNAME ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'lords_dashboard',
    synchronize: toBool(process.env.DB_SYNCHRONIZE, false),
    logging: toBool(process.env.DB_LOGGING, false),
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? '',
    callbackUrl:
      process.env.DISCORD_CALLBACK_URL ?? 'http://localhost:3000/api/auth/discord/callback',
    scopes: (process.env.DISCORD_SCOPES ?? 'identify email guilds').split(' ').filter(Boolean),
    guildId: process.env.DISCORD_GUILD_ID ?? '',
    // Default the mock ON only when no real client id is configured, so a fresh
    // `docker compose up` works with zero Discord setup; an explicit
    // DISCORD_MOCK always wins.
    mock: toBool(process.env.DISCORD_MOCK, !process.env.DISCORD_CLIENT_ID),
    mockDefaultPersona: process.env.DISCORD_MOCK_DEFAULT_PERSONA ?? 'owner',
  },
  frontend: {
    url: process.env.FRONTEND_URL ?? 'http://localhost:4200',
    authSuccessRedirect:
      process.env.FRONTEND_AUTH_SUCCESS_REDIRECT ?? 'http://localhost:4200/auth/callback',
    authFailureRedirect:
      process.env.FRONTEND_AUTH_FAILURE_REDIRECT ?? 'http://localhost:4200/login',
  },
});
