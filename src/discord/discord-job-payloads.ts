import { DiscordSyncJobType } from '../common/enums';
import { DiscordActionRow, DiscordEmbed, DiscordMentionAllowList } from './gateway/discord-gateway';

/**
 * The typed shapes of `discord_sync_jobs.payload` (T-0172).
 *
 * The worker used to read every payload as
 * `(job.payload ?? {}) as Record<string, string | undefined>` and then
 * `String(p.foo)` each value. That cast was a lie the moment a payload had to
 * carry a nested embed OBJECT, and `String(anEmbed)` would have silently posted
 * `[object Object]` to a live channel. The column is already MySQL `json`, so
 * nothing about the storage needed to change — only the typing.
 *
 * ⚠️ BACKWARD COMPATIBILITY: rows written before this change carry ONLY the
 * fields they always did. Every field added here is therefore OPTIONAL, and
 * every consumer must behave exactly as it did when the field is absent. A job
 * sitting in the outbox at deploy time delivers as plain text, unchanged.
 */

/** A message bound for a channel: pre-resolved channel + pre-composed content. */
export interface ChannelMessagePayload {
  channelId: string;
  /** Plain-text body. Empty (or absent) when the message IS the embed. */
  content?: string;
  /** Composed at enqueue time and already clamped to Discord's embed limits. */
  embed?: DiscordEmbed | null;
}

/**
 * An EVENT announcement (T-0205): a channel message that also carries RSVP
 * buttons, may ping one role, and reports back where it landed.
 *
 * Every added field is optional, so an `announce` row written before this change
 * still drains as the plain embed post it was enqueued as.
 */
export interface EventAnnouncePayload extends ChannelMessagePayload {
  /**
   * The event this announces. Present ⇒ the worker records the resulting message
   * id against it, which is what makes the announcement re-renderable later.
   */
  eventId?: string | null;
  components?: DiscordActionRow[] | null;
  /**
   * The role to ping, as an EXPLICIT allow-list. The `@role` text lives in the
   * message content; without a matching entry here it renders as an inert chip,
   * which is exactly what happens on every later re-render.
   */
  mentions?: DiscordMentionAllowList | null;
}

/**
 * A re-render / thread / close job for an announcement. Carries ONLY the event
 * id: everything else is re-read at drain time, because the RSVP roster changes
 * between enqueue and delivery — that is the whole reason the job exists.
 */
export interface EventAnnouncementPayload {
  eventId: string;
  /** Lead time in minutes, for the thread ping's own wording. */
  minutesBefore?: number;
}

/** A direct message to one user. */
export interface DirectMessagePayload {
  discordUserId: string;
  content?: string;
  embed?: DiscordEmbed | null;
}

/** The audit-log mirror: a channel post that reports its outcome back. */
export interface AuditMirrorPayload extends ChannelMessagePayload {
  /** Source `audit_log_entries.id`, so the worker can write synced/failed back. */
  auditEntryId?: string | null;
}

/** The welcome: a channel post when one is configured, otherwise a DM. */
export interface WelcomePayload {
  discordUserId: string;
  /** Null ⇒ no welcome channel configured ⇒ deliver as a DM instead. */
  channelId?: string | null;
  content?: string;
  embed?: DiscordEmbed | null;
}

/**
 * A gallery channel post (T-0195): the embed, plus optionally a bare media URL.
 *
 * ⚠️ `mediaUrl` IS A SECOND MESSAGE, not a field of the embed. Discord builds a
 * video player from a bare media URL in a message's CONTENT and never from a
 * URL inside an embed — so a playable submission genuinely requires two sends.
 * Absent/null (every pre-existing row, and every image or link submission) means
 * one message, exactly as before.
 */
export interface GalleryPostPayload extends ChannelMessagePayload {
  mediaUrl?: string | null;
}

/** Assign/remove one role from one user. */
export interface RoleTargetPayload {
  discordUserId: string;
  roleId: string;
}

/** Reconcile the managed roles of one member (which ones depends on the job type). */
export interface RoleSyncPayload {
  memberId: string;
  discordUserId: string;
}

/**
 * The role ids ONE scoped sync is allowed to touch (T-0209).
 *
 * ⚠️ THIS LIST IS THE ENTIRE PERMISSION. The worker re-derives what the member
 * *should* hold at drain time and then converges only these ids — assigning the
 * ones that belong and removing the ones that do not. Nothing outside the list
 * is read, compared or written, which is what makes the blast radius of a rank
 * change exactly two roles however large the catalogue grows.
 *
 * Re-deriving at DRAIN time rather than baking add/remove into the payload is
 * load-bearing, not stylistic: retry backoff reaches thirty minutes, and a
 * second award of a repeatable medal can land inside that window. A frozen
 * "remove this role" would then strip a medal the member had just re-earned; a
 * scope plus a fresh derivation cannot.
 */
export interface ScopedRoleSyncPayload extends RoleSyncPayload {
  roleIds: string[];
}

/**
 * One member's share of a bulk re-link. Carries BOTH ends of the mapping change,
 * so the drain is a two-id scoped sync rather than a whole-member reconcile.
 *
 * `incomingRoleId` is absent on rows queued before T-0209; the worker degrades to
 * stripping the outgoing role alone, which is exactly T-0159's original contract.
 */
export interface RoleRelinkApplyPayload extends RoleSyncPayload {
  outgoingRoleId?: string | null;
  incomingRoleId?: string | null;
}

/** Strip managed roles and apply the Ban role. */
export interface MemberBanRolePayload {
  discordUserId: string;
  reason?: string | null;
}

/** Which catalogue row a bulk Discord-role re-link fans out from. */
export type RoleRelinkSubject = 'rank' | 'medal';

/**
 * The cursor payload of a bulk re-link batch. Extends `Record<string, unknown>`
 * so it can be handed straight to `insertJob` without a cast.
 */
export interface RoleRelinkExpandPayload extends Record<string, unknown> {
  subject: RoleRelinkSubject;
  subjectId: string;
  subjectLabel: string;
  /** The previously-linked role to strip (T-0159). Null when there was none. */
  outgoingRoleId: string | null;
  incomingRoleId: string | null;
  /** Last member id of the previous page; null on the first page. */
  cursor: string | null;
  /**
   * The member who triggered the re-link, excluded from the fan-out so an actor
   * can never self-grant a role by editing a rank/medal they hold (LDA-H1).
   * Optional/nullable for backward compatibility with jobs enqueued before this.
   */
  excludeMemberId?: string | null;
}

/**
 * Job type → payload shape. Because the worker switches on `job.jobType`,
 * TypeScript narrows the key inside each `case` and this map hands back exactly
 * that arm's payload type — one cast, in one place, instead of a `String()` per
 * field.
 */
export interface DiscordJobPayloadMap {
  [DiscordSyncJobType.RoleAssign]: RoleTargetPayload;
  [DiscordSyncJobType.RoleRemove]: RoleTargetPayload;
  [DiscordSyncJobType.RoleGrant]: RoleSyncPayload;
  [DiscordSyncJobType.RoleScopedSync]: ScopedRoleSyncPayload;
  [DiscordSyncJobType.RoleFullResync]: RoleSyncPayload;
  [DiscordSyncJobType.MemberBanRole]: MemberBanRolePayload;
  [DiscordSyncJobType.Announce]: EventAnnouncePayload;
  [DiscordSyncJobType.EventReminder]: ChannelMessagePayload;
  [DiscordSyncJobType.EventAnnouncementRefresh]: EventAnnouncementPayload;
  [DiscordSyncJobType.EventThreadPing]: EventAnnouncementPayload;
  [DiscordSyncJobType.EventAnnouncementClose]: EventAnnouncementPayload;
  [DiscordSyncJobType.ApplicationSubmitted]: ChannelMessagePayload;
  [DiscordSyncJobType.GallerySubmitted]: GalleryPostPayload;
  [DiscordSyncJobType.GalleryApproved]: GalleryPostPayload;
  [DiscordSyncJobType.AuditLog]: AuditMirrorPayload;
  [DiscordSyncJobType.ApplicationDecision]: DirectMessagePayload;
  [DiscordSyncJobType.Welcome]: WelcomePayload;
  [DiscordSyncJobType.RoleRelinkExpand]: RoleRelinkExpandPayload;
  [DiscordSyncJobType.RoleRelinkApply]: RoleRelinkApplyPayload;
}
