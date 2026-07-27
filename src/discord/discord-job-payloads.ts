import { DiscordSyncJobType } from '../common/enums';
import { DiscordEmbed } from './gateway/discord-gateway';

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

/** Reconcile every managed role for one member. */
export interface RoleSyncPayload {
  memberId: string;
  discordUserId: string;
}

/** One member's share of a bulk re-link (carries the role that left the mapping). */
export interface RoleRelinkApplyPayload extends RoleSyncPayload {
  outgoingRoleId?: string | null;
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
  [DiscordSyncJobType.RoleSync]: RoleSyncPayload;
  [DiscordSyncJobType.MemberBanRole]: MemberBanRolePayload;
  [DiscordSyncJobType.Announce]: ChannelMessagePayload;
  [DiscordSyncJobType.EventReminder]: ChannelMessagePayload;
  [DiscordSyncJobType.ApplicationSubmitted]: ChannelMessagePayload;
  [DiscordSyncJobType.GallerySubmitted]: GalleryPostPayload;
  [DiscordSyncJobType.GalleryApproved]: GalleryPostPayload;
  [DiscordSyncJobType.AuditLog]: AuditMirrorPayload;
  [DiscordSyncJobType.ApplicationDecision]: DirectMessagePayload;
  [DiscordSyncJobType.Welcome]: WelcomePayload;
  [DiscordSyncJobType.RoleRelinkExpand]: RoleRelinkExpandPayload;
  [DiscordSyncJobType.RoleRelinkApply]: RoleRelinkApplyPayload;
}
