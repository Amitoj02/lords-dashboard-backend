/**
 * Strongly-typed configuration assembled from validated environment variables.
 * Consume via `ConfigService<AppConfig, true>` for end-to-end type safety, e.g.
 *   configService.get('discord', { infer: true }).clientId
 */
import { createHash } from 'crypto';

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
  storage: StorageConfig;
  integrations: IntegrationsConfig;
  gallery: GalleryConfig;
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
  /** The Discord bot (gateway) token. Empty until the production bot is provisioned. */
  botToken: string;
  /** The Discord application id the bot runs under. */
  applicationId: string;
  /**
   * When true, the in-process Discord GATEWAY (the "Lord Adjutant" bot) is
   * replaced by MockDiscordGateway — no discord.js Client is created and no
   * network I/O happens, so role sync + announcements can be exercised end-to-end
   * with no real bot. Defaults ON whenever no DISCORD_BOT_TOKEN is set; flip to
   * false with a real token to go live (mirrors the OAuth `mock` seam).
   */
  botMock: boolean;
}

export interface FrontendConfig {
  url: string;
  authSuccessRedirect: string;
  authFailureRedirect: string;
}

export interface StorageConfig {
  /**
   * The S3/MinIO endpoint used both to sign presigned upload URLs and to build
   * public object URLs. It MUST be reachable by the browser (which performs the
   * PUT), so in a Docker dev stack this is the host-mapped MinIO port, not the
   * internal `minio:9000` hostname.
   */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Base URL public objects are served from. Defaults to `{endpoint}/{bucket}`
   * (path-style) but can be overridden for a CDN / virtual-host layout.
   */
  publicBaseUrl: string;
  /** Path-style addressing (required by MinIO); virtual-host for real S3/CDN. */
  forcePathStyle: boolean;
  /** How long a presigned upload URL is valid, in seconds. */
  presignExpirySeconds: number;
  /** Upstream cap on any single upload, in MB (per-target caps may be lower). */
  maxUploadMb: number;
}

export interface IntegrationsConfig {
  /**
   * YouTube Data API v3 key. Optional: when empty, gallery link resolution falls
   * back to the static i.ytimg.com thumbnail and skips title/duration enrichment.
   */
  youtubeApiKey: string;
}

export interface GalleryConfig {
  /**
   * HMAC key that turns a viewer's IP address into the opaque `viewer_hash`
   * stored on `gallery_views` (T-0302). It is the ONLY thing standing between
   * that table and a reversible log of who read what — IPv4 is 2^32 candidates,
   * so an unkeyed hash of an address is not an anonymisation at all.
   *
   * Never null. When `GALLERY_VIEW_HASH_SECRET` is unset it is DERIVED from
   * `ENCRYPTION_KEY` (see below) rather than defaulted to a constant, so no
   * deployment can accidentally run with a publicly-known key.
   */
  viewHashSecret: string;
}

/**
 * The view-hash key: the explicit secret when one is configured, otherwise a
 * one-way derivation from `ENCRYPTION_KEY`.
 *
 * Deriving rather than requiring a new variable is deliberate. `ENCRYPTION_KEY`
 * is already required, already 32 bytes of real entropy, and already present in
 * every environment that boots this app (dev compose, CI, production) — so this
 * feature ships without a migration of anyone's environment, and there is no
 * window in which it silently runs on a weak key. The domain-separating prefix
 * means the derived value cannot be used to attack the AES key it came from.
 *
 * Setting `GALLERY_VIEW_HASH_SECRET` explicitly is still worth doing, for one
 * reason: it can then be ROTATED independently. Rotating it does not lose any
 * recorded view — the rows stay — but every returning visitor looks new once,
 * so counts step up slightly. That is the intended trade for forward secrecy.
 */
const viewHashSecret = (): string => {
  const explicit = process.env.GALLERY_VIEW_HASH_SECRET?.trim();
  if (explicit) return explicit;
  return createHash('sha256')
    .update(`gallery-view-hash:${process.env.ENCRYPTION_KEY ?? ''}`)
    .digest('hex');
};

export default (): AppConfig => {
  const env = (process.env.NODE_ENV as AppConfig['env']) ?? 'development';
  const isProd = env === 'production';
  return {
    env,
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
      scopes: (process.env.DISCORD_SCOPES ?? 'identify email').split(' ').filter(Boolean),
      guildId: process.env.DISCORD_GUILD_ID ?? '',
      // Default the mock ON only when no real client id is configured, so a fresh
      // `docker compose up` works with zero Discord setup; an explicit DISCORD_MOCK
      // always wins. NEVER auto-enable in production (LDA-C1): an absent
      // DISCORD_CLIENT_ID must break login loudly rather than silently swap in an
      // authentication bypass. In prod the mock is only ever on if DISCORD_MOCK is
      // explicitly set — and the boot guard (main.ts) then refuses to start unless
      // ALLOW_MOCKS_IN_PROD=true.
      mock: toBool(process.env.DISCORD_MOCK, !isProd && !process.env.DISCORD_CLIENT_ID),
      mockDefaultPersona: process.env.DISCORD_MOCK_DEFAULT_PERSONA ?? 'owner',
      botToken: process.env.DISCORD_BOT_TOKEN ?? '',
      applicationId: process.env.DISCORD_APPLICATION_ID ?? '',
      // Default the bot mock ON when no bot token is configured, so the whole sync
      // pipeline runs with zero Discord setup; an explicit DISCORD_BOT_MOCK wins.
      // Not auto-enabled in production either — but unlike the OAuth mock, a mocked
      // bot is NOT an auth bypass (it makes Discord side-effects no-ops), so prod may
      // legitimately run it (and does today) with only a loud boot warning.
      botMock: toBool(process.env.DISCORD_BOT_MOCK, !isProd && !process.env.DISCORD_BOT_TOKEN),
    },
    frontend: {
      url: process.env.FRONTEND_URL ?? 'http://localhost:4200',
      authSuccessRedirect:
        process.env.FRONTEND_AUTH_SUCCESS_REDIRECT ?? 'http://localhost:4200/auth/callback',
      authFailureRedirect:
        process.env.FRONTEND_AUTH_FAILURE_REDIRECT ?? 'http://localhost:4200/login',
    },
    storage: (() => {
      // Host-mapped MinIO by default (the browser PUTs here). capybara-rustfs holds
      // 9000/9001 locally, so the dev compose maps MinIO to 9100/9101.
      const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9100';
      const bucket = process.env.S3_BUCKET ?? 'lords-media';
      return {
        endpoint,
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
        bucket,
        publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? `${endpoint}/${bucket}`,
        forcePathStyle: toBool(process.env.S3_FORCE_PATH_STYLE, true),
        presignExpirySeconds: parseInt(process.env.S3_PRESIGN_EXPIRY_SECONDS ?? '900', 10),
        maxUploadMb: parseInt(process.env.S3_MAX_UPLOAD_MB ?? '100', 10),
      };
    })(),
    integrations: {
      youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
    },
    gallery: {
      viewHashSecret: viewHashSecret(),
    },
  };
};
