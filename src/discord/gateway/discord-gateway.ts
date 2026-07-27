/** A Discord role as the bot sees it. */
export interface DiscordRole {
  id: string;
  name: string;
  position: number;
  /**
   * The role's permission bitfield as a decimal string (exactly as Discord's API
   * serialises it — the value can exceed Number.MAX_SAFE_INTEGER). Load-bearing
   * for link validation (LDA-H1): a role carrying privileged bits must never be
   * linkable to a rank/medal. Kept as a string so no discord.js type leaks here.
   */
  permissions: string;
  /**
   * True for integration/booster-managed roles, which a bot cannot assign. Also
   * rejected at link time (LDA-H1).
   */
  managed: boolean;
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

// ── Message components + mentions (T-0205) ───────────────────────────────────
//
// The same rule as the embeds above: these are OURS. They are plain data so a
// component set can travel through the `discord_sync_jobs.payload` JSON column
// and come back out as itself, and so discord.js stays confined to
// RealDiscordGateway. The gateway re-shapes them at the edge.

/** One button in a message action row. */
export interface DiscordButton {
  /** Up to 100 chars, echoed back verbatim on the interaction. */
  customId: string;
  label: string;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  /** A unicode emoji shown before the label. */
  emoji?: string;
  disabled?: boolean;
}

/** A row of up to five buttons under a message. */
export interface DiscordActionRow {
  buttons: DiscordButton[];
}

/**
 * ⚠️ THE ONLY WAY TO MAKE AN OUTBOUND MESSAGE PING ANYONE.
 *
 * Every send neutralises mention resolution with `parse: []` (LDA-M6), which is
 * what keeps an `@everyone` typed into an admin-authored string inert. An event
 * announcement genuinely has to ping ONE role, and an event thread has to ping
 * the members who said they are coming — so the allow-list is an EXPLICIT LIST
 * OF IDS, never a parse type. `parse` is still sent as `[]` alongside it, so
 * `@everyone`/`@here` remain unresolvable no matter what text the message
 * carries; only the snowflakes named here can notify anybody.
 */
export interface DiscordMentionAllowList {
  /** Role snowflakes that may be pinged (Discord caps this at 100). */
  roles?: string[];
  /** User snowflakes that may be pinged (Discord caps this at 100). */
  users?: string[];
}

/**
 * The optional extras of a send. Deliberately a fourth OPTIONAL argument rather
 * than a reshaped signature: every pre-existing caller passes two or three
 * arguments and keeps behaving exactly as it did — the same additive move that
 * introduced `embeds` in T-0172, and what keeps outbox rows written before this
 * change delivering unchanged.
 */
export interface DiscordSendExtras {
  components?: DiscordActionRow[];
  mentions?: DiscordMentionAllowList;
}

/** The fields of an existing message a re-render may replace. */
export interface DiscordMessageEdit {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
}

/** A button press, reduced to what the app needs to act on it. */
export interface DiscordButtonPress {
  /** The button's `customId`, exactly as it was composed. */
  customId: string;
  /** Who pressed it. */
  discordUserId: string;
  /** The channel (or thread) the message lives in. */
  channelId: string;
  /** The message the button is attached to. */
  messageId: string;
}

/** What a handler wants said back to the presser, privately. */
export interface DiscordInteractionReply {
  content: string;
}

/**
 * Subscribe to button presses. Returning null means "not mine" — the gateway
 * then tries the next handler, so several features can own different buttons
 * without knowing about each other. Handlers must not throw; the gateway
 * isolates them anyway, exactly like the member-event fan-out.
 */
export type DiscordInteractionHandler = (
  press: DiscordButtonPress,
) => Promise<DiscordInteractionReply | null>;

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
    extras?: DiscordSendExtras,
  ): Promise<{ messageId: string }>;

  /**
   * Re-render an ALREADY POSTED message (T-0205). Only the keys present in
   * `update` are replaced — passing `components: []` is how the RSVP buttons are
   * cleared, while omitting the key leaves them alone.
   *
   * An edit can never introduce a ping: no mention allow-list is accepted here,
   * so the implementation pins `parse: []` and nothing else. That matters
   * because the announcement is re-rendered on every RSVP — without it, each
   * refresh would re-notify the pinged role.
   */
  abstract editChannelMessage(
    channelId: string,
    messageId: string,
    update: DiscordMessageEdit,
  ): Promise<void>;

  /**
   * Open a thread hanging off an existing message (T-0205) and return its id —
   * which is itself a channel id, so {@link sendChannelMessage} posts into it.
   *
   * This is what replaces DM'ing every attendee when an event is about to start:
   * Discord's own policy treats unsolicited mass DMs as abuse, and a thread
   * reaches exactly the same people with one message.
   */
  abstract createMessageThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<{ threadId: string }>;

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
   * Subscribe to BUTTON presses (T-0205). Accumulates like the member handlers,
   * and for the same reason: the presses are dispatched by `customId`, so a
   * second feature's buttons must not displace the first's.
   *
   * ⚠️ This is the bot's first INBOUND path. Everything before it was outbound —
   * the module header's "no slash commands" still holds (there are none), but
   * "the bot only posts and manages roles" no longer does: a member can now
   * change roster state by pressing a button, so the handler is responsible for
   * the same authorisation the HTTP route would apply.
   */
  abstract registerInteractionHandler(handler: DiscordInteractionHandler): void;

  /**
   * Dev/testing hook implemented ONLY by {@link MockDiscordGateway}: fire the
   * registered join handlers as if Discord had delivered GuildMemberAdd.
   * Optional (not `abstract`) so the real gateway is not forced to fake events;
   * callers must null-check it.
   */
  simulateMemberJoin?(discordUserId: string): Promise<void>;

  /** Dev/testing counterpart of {@link simulateMemberJoin} (GuildMemberRemove). */
  simulateMemberLeave?(discordUserId: string): Promise<void>;

  /**
   * Dev/testing hook (mock only): deliver a button press as if Discord had sent
   * an InteractionCreate, and hand back what the presser would have been told.
   */
  simulateButtonPress?(press: DiscordButtonPress): Promise<DiscordInteractionReply | null>;
}
