import * as Joi from 'joi';

/**
 * Joi schema validating every environment variable the app depends on.
 * The application refuses to boot if anything is missing or malformed —
 * fail fast at startup rather than at the first request.
 */
export const envValidationSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api'),
  CORS_ORIGINS: Joi.string().default('http://localhost:4200'),

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

  // Discord OAuth2 — required for the auth flow to function, but allowed empty
  // so the app can boot in environments where Discord login is not yet configured.
  DISCORD_CLIENT_ID: Joi.string().allow('').default(''),
  DISCORD_CLIENT_SECRET: Joi.string().allow('').default(''),
  DISCORD_CALLBACK_URL: Joi.string()
    .uri()
    .default('http://localhost:3000/api/auth/discord/callback'),
  DISCORD_SCOPES: Joi.string().default('identify email guilds'),
  DISCORD_GUILD_ID: Joi.string().allow('').default(''),

  // Frontend redirect targets
  FRONTEND_URL: Joi.string().uri().default('http://localhost:4200'),
  FRONTEND_AUTH_SUCCESS_REDIRECT: Joi.string().uri().default('http://localhost:4200/auth/callback'),
  FRONTEND_AUTH_FAILURE_REDIRECT: Joi.string().uri().default('http://localhost:4200/login'),
});
