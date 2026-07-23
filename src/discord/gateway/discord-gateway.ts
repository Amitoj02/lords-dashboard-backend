/** A Discord role as the bot sees it. */
export interface DiscordRole {
  id: string;
  name: string;
  position: number;
}

/** A Discord text channel the bot can post to (surfaced to the channel picker). */
export interface DiscordChannel {
  id: string;
  name: string;
}

/** A guild member as the bot sees it (role snowflakes it currently holds). */
export interface DiscordGuildMemberRef {
  id: string;
  roles: string[];
  joinedAt: string | null;
}

/** Live connection/authority snapshot the wizard + bot-status screen read. */
export interface DiscordGatewayStatus {
  connected: boolean;
  botVersion: string | null;
  totalRoles: number | null;
  botRolePosition: number | null;
  membersVisible: number | null;
  // ── Live runtime metrics (T-0076) — all null when disconnected ──────────────
  /** WebSocket heartbeat latency in ms (discord.js `client.ws.ping`). */
  wsPing: number | null;
  /** How long the gateway has been connected, in ms. */
  uptimeMs: number | null;
  /** Resident set size of the bot process, in bytes. */
  memoryBytes: number | null;
  /** Average CPU utilization of the process since start, as a percentage. */
  cpu: number | null;
  /** ISO timestamp the gateway became ready. */
  readyAt: string | null;
}

// ── Structured embeds (T-0172) ───────────────────────────────────────────────
//
// These mirror Discord's embed object, but they are OURS: plain, structural,
// JSON-serialisable interfaces with no discord.js in sight. That is deliberate
// and load-bearing:
//
//  1. discord.js is imported in exactly ONE file (RealDiscordGateway). Typing an
//     outbox payload with discord.js's `APIEmbed` would leak that dependency
//     into the sync service, the entity and the mock.
//  2. An embed TRAVELS THROUGH THE DATABASE — it is composed at enqueue time and
//     read back by the worker minutes later out of a MySQL `json` column. A
//     discord.js `EmbedBuilder` instance is a class, not data, and does not
//     survive `JSON.stringify` → `JSON.parse` as itself. Only a plain object can
//     be a job payload.
//
// RealDiscordGateway converts these to discord.js at the edge; everything else
// in `src/` speaks only this shape.

/** One name/value row of an embed. */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * A Discord message embed, reduced to the parts this app actually sends. URLs
 * are flattened (`thumbnailUrl` rather than `{ thumbnail: { url } }`) because a
 * flat shape is far easier to compose, clamp and assert on; the gateway
 * re-nests them for the API. `color` is an integer RGB value (0xRRGGBB) and
 * `timestamp` an ISO-8601 string, exactly as Discord expects them.
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: DiscordEmbedField[];
  author?: { name: string; iconUrl?: string; url?: string };
  footer?: { text: string; iconUrl?: string };
  thumbnailUrl?: string;
  imageUrl?: string;
}

/** Handler invoked when a member joins the guild (drives onboarding). */
export type MemberJoinHandler = (discordUserId: string) => void | Promise<void>;

/**
 * Handler invoked when a member LEAVES the guild (T-0169). Symmetric with
 * {@link MemberJoinHandler}: without it a departure was invisible to the app and
 * the stored membership verdict stayed true until the member next signed in.
 */
export type MemberLeaveHandler = (discordUserId: string) => void | Promise<void>;

/**
 * The bot's Discord side, abstracted so the whole sync pipeline can run against
 * an in-process {@link MockDiscordGateway} with no real bot. The concrete
 * implementation is chosen by a factory in DiscordModule based on
 * `config.discord.botMock` — mirroring the OAuth mock/real seam. Every method is
 * expected to be called ONLY by the outbox worker (which isolates failures), so
 * implementations may throw on transient errors; the worker retries/records them.
 */
export abstract class DiscordGateway {
  abstract getStatus(): Promise<DiscordGatewayStatus>;
  abstract listRoles(): Promise<DiscordRole[]>;
  abstract listChannels(): Promise<DiscordChannel[]>;
  abstract assignRole(discordUserId: string, roleId: string): Promise<void>;
  abstract removeRole(discordUserId: string, roleId: string): Promise<void>;
  /**
   * Post to a channel. `embeds` is OPTIONAL and additive (T-0172): every
   * pre-existing caller passes two arguments and keeps behaving exactly as it
   * did, which is what lets outbox rows written before this change — they carry
   * only `content` — keep delivering as plain text after deploy. `content` may
   * be empty when the message IS the embed.
   */
  abstract sendChannelMessage(
    channelId: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): Promise<{ messageId: string }>;

  /**
   * DM a user. Returns `{ messageId }` like {@link sendChannelMessage}.
   *
   * T-0172 resolved the old asymmetry (channel → `{ messageId }`, DM → `void`)
   * in favour of the richer shape rather than the poorer one: a DM genuinely
   * HAS a message id (discord.js `User#send` resolves to a Message), the `void`
   * return was simply discarding it. No caller reads the result today, so
   * widening is source-compatible, and an embed DM is now as traceable as an
   * embed channel post.
   */
  abstract sendDirectMessage(
    discordUserId: string,
    content: string,
    embeds?: DiscordEmbed[],
  ): Promise<{ messageId: string }>;

  abstract fetchMember(discordUserId: string): Promise<DiscordGuildMemberRef | null>;

  /**
   * Subscribe to GuildMemberAdd (best-effort). Handlers ACCUMULATE — there are
   * two independent subscribers now (onboarding, and the guild-membership
   * verdict writer added by T-0169) and neither may silently displace the other,
   * so this adds rather than replaces.
   */
  abstract registerMemberJoinHandler(handler: MemberJoinHandler): void;

  /** Subscribe to GuildMemberRemove (T-0169). Accumulates, like the join side. */
  abstract registerMemberLeaveHandler(handler: MemberLeaveHandler): void;

  /**
   * Dev/testing hook implemented ONLY by {@link MockDiscordGateway}: fire the
   * registered join handlers as if Discord had delivered GuildMemberAdd.
   * Optional (not `abstract`) so the real gateway is not forced to fake events;
   * callers must null-check it.
   */
  simulateMemberJoin?(discordUserId: string): Promise<void>;

  /** Dev/testing counterpart of {@link simulateMemberJoin} (GuildMemberRemove). */
  simulateMemberLeave?(discordUserId: string): Promise<void>;
}
