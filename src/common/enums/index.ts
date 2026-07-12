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

export enum MedalRibbon {
  Blue = 'blue',
  Red = 'red',
  Gold = 'gold',
  Green = 'green',
  Tricolor = 'tricolor',
}

export enum EventStatus {
  Upcoming = 'upcoming',
  Ongoing = 'ongoing',
  Previous = 'previous',
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
}

/** The kind of work a Discord sync job performs when the worker drains it. */
export enum DiscordSyncJobType {
  RoleAssign = 'role.assign',
  RoleRemove = 'role.remove',
  RoleSync = 'role.sync',
  /** Strip managed roles + apply the configured Ban role on an app-side ban. */
  MemberBanRole = 'member.ban_role',
  Announce = 'announce',
  Welcome = 'welcome',
  /** Post a new enlistment application to the enlistments channel (T-0042). */
  ApplicationSubmitted = 'application.submitted',
  /** Mirror an audit-log entry to the audit-log channel (T-0043). */
  AuditLog = 'audit.log',
  /** DM an applicant the outcome of a decision (approve/decline/hold). */
  ApplicationDecision = 'application.decision',
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

/** Capability keys for the role/permission matrix (role_permissions.capability). */
export enum Capability {
  ManageSettings = 'manage_settings',
  TransferOwnership = 'transfer_ownership',
  ManageRoles = 'manage_roles',
  ViewAuditLog = 'view_audit_log',
  EditRanksMedals = 'edit_ranks_medals',
  ManageApplications = 'manage_applications',
  ManageEvents = 'manage_events',
  ModerateGallery = 'moderate_gallery',
  RevealEventPasswords = 'reveal_event_passwords',
  SubmitToGallery = 'submit_to_gallery',
  RsvpToEvents = 'rsvp_to_events',
  ViewMembersDirectory = 'view_members_directory',
  ApplyToJoin = 'apply_to_join',
  ManageNotifications = 'manage_notifications',
}
