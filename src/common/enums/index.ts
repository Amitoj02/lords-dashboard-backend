/**
 * Domain enumerations shared by entities, DTOs and guards.
 * String values mirror EXACTLY what the Angular frontend emits/consumes, so the
 * API contract is preserved (note the deliberate mixed casing: roles are
 * Capitalized, platforms/statuses are lowercase, etc.).
 */

export enum MemberRole {
  Owner = 'Owner',
  Admin = 'Admin',
  Moderator = 'Moderator',
  Member = 'Member',
  Mercenary = 'Mercenary',
  Applicant = 'Applicant',
}

/**
 * The enlistment track an applicant chooses on the apply form (T-0095). On
 * approval it selects the enrolled {@link MemberRole}: Member → Member,
 * Mercenary → Mercenary.
 */
export enum ApplicantType {
  Member = 'Member',
  Mercenary = 'Mercenary',
}

export enum MemberStatus {
  Active = 'Active',
  Inactive = 'Inactive',
  Pending = 'Pending',
}

export enum Platform {
  Steam = 'steam',
  Xbox = 'xbox',
  PlayStation = 'ps',
}

export enum EventStatus {
  Upcoming = 'upcoming',
  Ongoing = 'ongoing',
  Previous = 'previous',
}

/**
 * Cadence of a recurring event template. A template with a cadence and
 * `recurrenceActive` set has its future occurrences materialized as real event
 * rows by the recurrence scheduler (T-0074/T-0075).
 */
export enum RecurrenceCadence {
  Daily = 'daily',
  Weekly = 'weekly',
  Monthly = 'monthly',
}

export enum RsvpStatus {
  Interested = 'interested',
  Tentative = 'tentative',
  Declined = 'declined',
  Neutral = 'neutral',
}

export enum GalleryType {
  Image = 'image',
  Video = 'video',
  Link = 'link',
}

export enum GalleryStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

export enum GalleryMediaType {
  Image = 'image',
  Video = 'video',
}

/** Resolved provider of an external gallery media link (server-side resolver). */
export enum MediaProvider {
  YouTube = 'youtube',
  MedalTv = 'medaltv',
  Image = 'image',
  Video = 'video',
  Link = 'link',
}

export enum ApplicationStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
  Held = 'held',
}

export enum AuditSeverity {
  Info = 'info',
  Warn = 'warn',
  Error = 'err',
}

export enum AuditActorType {
  Member = 'member',
  Bot = 'bot',
  System = 'system',
}

export enum DiscordSyncStatus {
  Pending = 'pending',
  Synced = 'synced',
  Failed = 'failed',
  NotApplicable = 'not_applicable',
}

export enum BotConnectionStatus {
  Idle = 'idle',
  Checking = 'checking',
  Connected = 'connected',
  Error = 'error',
}

/** Lifecycle of a queued Discord sync job in the outbox (discord_sync_jobs). */
export enum DiscordSyncJobStatus {
  Pending = 'pending',
  Processing = 'processing',
  Succeeded = 'succeeded',
  Failed = 'failed',
  /**
   * Terminal, operator-initiated stop (T-0160). Distinct from Failed so a
   * cancelled bulk run is not reported as an error and does not burn retries.
   * Work already applied before the cancel is NOT rolled back — the run is
   * reported as partial.
   */
  Cancelled = 'cancelled',
}

/** The kind of work a Discord sync job performs when the worker drains it. */
export enum DiscordSyncJobType {
  RoleAssign = 'role.assign',
  RoleRemove = 'role.remove',
  RoleSync = 'role.sync',
  /** Strip managed roles + apply the configured Ban role on an app-side ban. */
  MemberBanRole = 'member.ban_role',
  Announce = 'announce',
  /**
   * A lead-time reminder for an event (T-0174), fired by the reminder scheduler
   * from an `event_notify_offsets` row. Deliberately its OWN type rather than
   * another {@link Announce}: the two are visually distinct messages, and a
   * separate type is what lets the operations ledger, the delivery matrix and a
   * future rate-limit tell "the event was created" apart from "the event is
   * about to start".
   */
  EventReminder = 'event.reminder',
  /**
   * Re-render an event announcement in place (T-0205), so the embed's
   * Attending/Tentative/Declined sections match the RSVPs as they stand.
   *
   * Its payload carries ONLY the event id: the roster is recomposed at DRAIN
   * time, not at enqueue. That is the opposite of every other message producer
   * here and is deliberate — the refresh is coalesced (one pending job per
   * event, however many people are pressing buttons), so a payload composed at
   * enqueue would deliver the FIRST presser's roster and silently drop everyone
   * who clicked after it.
   */
  EventAnnouncementRefresh = 'event.announce.refresh',
  /**
   * Open a thread on the event announcement and ping everyone who said they are
   * coming (T-0205). Fired by the reminder scheduler at the event's configured
   * lead time, and the reason the app does not DM attendees: Discord's policy
   * treats unsolicited mass DMs as abuse, while one thread message reaches the
   * same people.
   */
  EventThreadPing = 'event.thread.ping',
  /**
   * Retire an ended event's RSVP buttons (T-0205) by re-rendering the
   * announcement with them disabled. The message stays as the historical record;
   * only the controls go dead.
   */
  EventAnnouncementClose = 'event.announce.close',
  Welcome = 'welcome',
  /** Post a new enlistment application to the enlistments channel (T-0042). */
  ApplicationSubmitted = 'application.submitted',
  /** Post a new gallery submission to the staff review channel (T-0195). */
  GallerySubmitted = 'gallery.submitted',
  /**
   * Showcase an APPROVED gallery item in the public gallery channel (T-0195).
   * Separate from {@link GallerySubmitted} rather than a flag on it because the
   * two go to different channels with different audiences, and the operations
   * ledger reports on them separately — the same reason Announce and
   * EventReminder are two types.
   */
  GalleryApproved = 'gallery.approved',
  /** Mirror an audit-log entry to the audit-log channel (T-0043). */
  AuditLog = 'audit.log',
  /** DM an applicant the outcome of a decision (approve/decline/hold). */
  ApplicationDecision = 'application.decision',
  /**
   * Cursor job for a rank/medal Discord-role re-link (T-0158). One row is
   * enqueued per re-link; each drain expands a bounded PAGE of affected members
   * into {@link RoleRelinkApply} jobs and then RE-ENQUEUES ITSELF with the next
   * cursor. That keeps memory flat, makes the expansion resumable after a
   * restart, and gives the operator a cancel point between pages — none of
   * which a single up-front 600-row insert would offer.
   */
  RoleRelinkExpand = 'role.relink_expand',
  /**
   * Apply one member's share of a re-link (T-0158/T-0159). Deliberately NOT a
   * plain RoleSync job: `reconcileRoles` recomputes the desired role set from
   * the CURRENT rank/medal rows, so by the time it runs the outgoing role is
   * already gone from the mapping and is structurally unknowable. This job type
   * carries `outgoingRoleId` in its payload so the previously-linked role can be
   * stripped as well as the new one applied.
   */
  RoleRelinkApply = 'role.relink_apply',
}

/**
 * Terminal/at-rest state of a bulk Discord role re-link run (T-0160), derived
 * from its job rows rather than held in memory, so it survives an API restart.
 */
export enum RoleRelinkBatchState {
  /** Still expanding pages and/or applying per-member jobs. */
  Running = 'running',
  /** Fully drained. `failed` may still be non-zero - the counts tell the story. */
  Completed = 'completed',
  /** Cancelled after some members were already updated; those stay correct. */
  Partial = 'partial',
  /** Cancelled before any member was updated. */
  Cancelled = 'cancelled',
}

export enum NotificationTone {
  Info = 'info',
  Warn = 'warn',
  Ok = 'ok',
}

export enum AccountDeletionStatus {
  PendingDiscordConfirmation = 'pending_discord_confirmation',
  Confirmed = 'confirmed',
  Executed = 'executed',
  Cancelled = 'cancelled',
}

/**
 * Upload targets for the presigned-upload API (T-0066). Each target maps to a
 * key namespace, a required capability, and a content-type/size policy.
 */
export enum StorageTarget {
  MemberAvatar = 'member-avatar',
  MemberBanner = 'member-banner',
  EventBanner = 'event-banner',
  MedalImage = 'medal-image',
  RankImage = 'rank-image',
  Gallery = 'gallery',
  /** Landing-page hero background (T-0148). */
  RegimentHeroBanner = 'regiment-hero-banner',
  /** Sign-in page background (T-0148). */
  RegimentLoginBanner = 'regiment-login-banner',
  /**
   * A still frame captured from a directly-uploaded gallery video, used as the
   * grid thumbnail (T-0152). Namespaced UNDER the submitter's gallery prefix but
   * in a distinct `posters/` sub-path, so a poster key and a media key can never
   * be swapped for one another (the key-shape check in
   * {@link StorageService.resolveKeyToPublicUrl} rejects the crossover in both
   * directions).
   */
  GalleryPoster = 'gallery-poster',
}

/**
 * The admin-editable legal documents published on the public site (T-0149). The
 * slug is the stable key AND the public route segment (`/terms`, `/privacy`,
 * `/guidelines`), so it must never be renamed once shipped.
 */
export enum RegimentDocumentSlug {
  Terms = 'terms',
  Privacy = 'privacy',
  Guidelines = 'guidelines',
}

/**
 * Capability keys for the role/permission matrix (role_permissions.capability).
 *
 * `transfer_ownership` was retired in T-0170 along with both transfer
 * endpoints. The enum is the derived capability axis for GET/PATCH
 * /api/settings/permissions, so deleting the member is what makes the row
 * vanish from the matrix and makes an edit naming it a 400 — do not re-add it
 * without also restoring a route that consumes it.
 */
export enum Capability {
  ManageSettings = 'manage_settings',
  ManageRoles = 'manage_roles',
  ViewAuditLog = 'view_audit_log',
  EditRanksMedals = 'edit_ranks_medals',
  ManageApplications = 'manage_applications',
  ManageEvents = 'manage_events',
  ViewGallery = 'view_gallery',
  ModerateGallery = 'moderate_gallery',
  RevealEventPasswords = 'reveal_event_passwords',
  SubmitToGallery = 'submit_to_gallery',
  RsvpToEvents = 'rsvp_to_events',
  ViewMembersDirectory = 'view_members_directory',
  ApplyToJoin = 'apply_to_join',
  /**
   * Edit the regiment's public presentation (landing/login banners, quotes,
   * overlay density) and the legal documents (T-0145). Deliberately separate
   * from ManageSettings: this is the copy the whole internet sees, so it can be
   * delegated to whoever writes it without also handing over the permission
   * matrix or the Discord bot configuration.
   */
  ManageRegimentDetails = 'manage_regiment_details',
}
