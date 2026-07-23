import * as Joi from 'joi';

/**
 * Joi schema validating every environment variable the app depends on.
 * The application refuses to boot if anything is missing or malformed —
 * fail fast at startup rather than at the first request.
 */
export const envValidationSchema = Joi.object({
  // Application. Required with NO default (LDA-M7): a missing/typo'd NODE_ENV must
  // fail fast, not silently degrade to `development` (which mounts Swagger and
  // drops the cookie `Secure` flag). Every context that boots this schema already
  // sets it — `.env`/`.env.example` (development), CI job env (test), and both
  // compose files (production/development).
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api'),
  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),
  // Trust the client-suppliable CF-Connecting-IP header for rate limiting (LDA-H3).
  // Default false: only set true once Cloudflare-only ingress (AOP/mTLS or a
  // firewall pinning :443 to Cloudflare) is enforced, so the header cannot be
  // spoofed by a direct-to-origin client. Otherwise the socket peer IP is used.
  TRUST_CF_CONNECTING_IP: Joi.boolean().default(false),

  // Database
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(3306),
  DB_USERNAME: Joi.string().default('root'),
  DB_PASSWORD: Joi.string().allow('').default(''),
  DB_DATABASE: Joi.string().default('lords_dashboard'),
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),

  // JWT
  JWT_SECRET: Joi.string().min(16).required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),

  // Encryption at rest (AES-256-GCM) — exactly 64 hex chars (32 bytes)
  ENCRYPTION_KEY: Joi.string()
    .length(64)
    .pattern(/^[0-9a-fA-F]+$/)
    .required(),

  // Escape hatch for running the mocks in production (LDA-C1). Default false:
  // production fails CLOSED on the OAuth mock unless this is explicitly set. It
  // only PERMITS mocks — it never enables them — so setting it does not, by
  // itself, turn on the auth bypass.
  ALLOW_MOCKS_IN_PROD: Joi.boolean().default(false),

  // Discord OAuth2 — required for the auth flow to function, but allowed empty
  // so the app can boot in environments where Discord login is not yet configured.
  // In PRODUCTION a real DISCORD_CLIENT_ID is required (LDA-C1/M8) UNLESS the mock
  // is explicitly permitted (ALLOW_MOCKS_IN_PROD=true) — an empty client id in
  // prod otherwise means login is silently broken.
  DISCORD_CLIENT_ID: Joi.string()
    .allow('')
    .default('')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.when('ALLOW_MOCKS_IN_PROD', {
        is: true,
        then: Joi.string().allow('').default(''),
        otherwise: Joi.string().min(1).required(),
      }),
    }),
  DISCORD_CLIENT_SECRET: Joi.string().allow('').default(''),
  DISCORD_CALLBACK_URL: Joi.string()
    .uri()
    .default('http://localhost:3000/api/auth/discord/callback'),
  // `identify email` only — guild membership is resolved from the bot (T-0050),
  // so the `guilds` scope is no longer requested.
  DISCORD_SCOPES: Joi.string().default('identify email'),
  // Guild membership verification + role sync no-op silently when this is empty
  // (LDA-M8). It is only load-bearing once the REAL bot runs, so it is required in
  // production only when the bot is NOT mocked — today's prod (DISCORD_BOT_MOCK=true)
  // keeps booting with it unset, but the moment a real bot is enabled it must be set.
  DISCORD_GUILD_ID: Joi.string()
    .allow('')
    .default('')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.when('DISCORD_BOT_MOCK', {
        is: true,
        then: Joi.string().allow('').default(''),
        otherwise: Joi.string()
          .pattern(/^\d{17,20}$/)
          .required(),
      }),
    }),
  // Discord mock — replaces the OAuth2 network calls with an in-process stub so
  // the sign-in flow works with no Discord app. Left optional (no default) so the
  // effective value is computed in configuration.ts: ON when no client id is set.
  DISCORD_MOCK: Joi.boolean(),
  DISCORD_MOCK_DEFAULT_PERSONA: Joi.string().default('owner'),

  // Discord BOT (gateway) — the in-process "Lord Adjutant" that syncs roles +
  // posts announcements. Allowed empty so the app boots with the bot mocked.
  DISCORD_BOT_TOKEN: Joi.string().allow('').default(''),
  DISCORD_APPLICATION_ID: Joi.string().allow('').default(''),
  // Bot mock — replaces the discord.js gateway with an in-process stub. Left
  // optional (no default) so the effective value is computed in configuration.ts:
  // ON when no bot token is set.
  DISCORD_BOT_MOCK: Joi.boolean(),

  // Frontend redirect targets
  FRONTEND_URL: Joi.string().uri().default('http://localhost:4200'),
  FRONTEND_AUTH_SUCCESS_REDIRECT: Joi.string().uri().default('http://localhost:4200/auth/callback'),
  FRONTEND_AUTH_FAILURE_REDIRECT: Joi.string().uri().default('http://localhost:4200/login'),

  // S3-compatible object storage (MinIO in dev). Defaults target the compose
  // MinIO service so a fresh `docker compose up` works with no editing; the URI
  // + numeric formats are validated so a malformed value fails fast at boot.
  S3_ENDPOINT: Joi.string().uri().default('http://localhost:9100'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: Joi.string().default('minioadmin'),
  S3_SECRET_ACCESS_KEY: Joi.string().default('minioadmin'),
  S3_BUCKET: Joi.string().default('lords-media'),
  // Optional explicit public base; when omitted it is derived as {endpoint}/{bucket}.
  S3_PUBLIC_BASE_URL: Joi.string().uri().optional(),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),
  S3_PRESIGN_EXPIRY_SECONDS: Joi.number().integer().min(60).max(3600).default(900),
  S3_MAX_UPLOAD_MB: Joi.number().integer().min(1).max(2048).default(100),

  // External integrations — optional third-party API keys. Allowed empty so the
  // app boots without them; the dependent feature degrades gracefully when unset.
  // YOUTUBE_API_KEY enables YouTube Data API enrichment (canonical title +
  // duration) for gallery links; without it the static i.ytimg thumbnail is used.
  YOUTUBE_API_KEY: Joi.string().allow('').default(''),
});
