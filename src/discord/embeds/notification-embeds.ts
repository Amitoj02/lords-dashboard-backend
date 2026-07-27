import { DateTime } from 'luxon';
import { DiscordEmbed, DiscordEmbedField } from '../gateway/discord-gateway';
import { clampEmbed } from './embed-limits';

/**
 * Accent-tone key → embed colour, mirroring `src/database/seeds/accent-tones.seed.ts`.
 *
 * The tone hex lives in the `accent_tones` reference table, but that table is
 * not registered with the runtime DataSource and reading it would cost a join
 * on every enqueue for six static rows. This is code-owned reference data on
 * both sides (the seed refreshes every deploy), so a literal map is the honest
 * shape — and an unknown key degrades to brass rather than to "no colour".
 */
const ACCENT_COLOURS: Record<string, number> = {
  brass: 0xbf9447,
  crimson: 0x8b2c2c,
  royal: 0x3b5bdb,
  forest: 0x2d6a4f,
  pewter: 0x6c757d,
  oxblood: 0x6b1a1a,
};

const DEFAULT_ACCENT = ACCENT_COLOURS.brass;

/** Outcome colours. Deliberately NOT the regiment accent — these carry meaning. */
export const OUTCOME_COLOURS = {
  approve: 0x2d6a4f,
  decline: 0x8b2c2c,
  hold: 0xb8860b,
  /** An event announcement, and — a shade apart — its later reminder. */
  event: 0x3b5bdb,
  reminder: 0xb8860b,
  welcome: 0x2d6a4f,
} as const;

/** Audit severity → colour for the high-volume channel mirror. */
const SEVERITY_COLOURS: Record<string, number> = {
  info: 0x6c757d,
  warn: 0xb8860b,
  err: 0x8b2c2c,
};

/**
 * The regiment's identity as a notification needs it. Resolved ONCE by
 * {@link DiscordSyncService} and handed to every composer, so a composer stays
 * a pure function of its inputs and can be unit-tested without a database.
 */
export interface RegimentBrand {
  name: string;
  /** Accent tone key (`regiments.accent_tone`), e.g. `brass`. */
  accentTone: string | null;
  bannerUrl: string | null;
  crestUrl: string | null;
}

/** The regiment's accent tone as an embed colour integer. */
export function brandColour(brand: RegimentBrand): number {
  return (brand.accentTone && ACCENT_COLOURS[brand.accentTone]) || DEFAULT_ACCENT;
}

/** The reshaped enlistment fields rendered into the #new-enlistments post. */
export interface EnlistmentSummary {
  applicantName: string;
  inGameName: string;
  currentRegiment: string;
  howFound: string;
  preferredClasses: string;
  skillsToImprove: string;
  representativeNote: string | null;
  /** The applicant's Discord avatar, used as the thumbnail. Null ⇒ no thumbnail. */
  avatarUrl?: string | null;
  /** ISO-8601 submission instant, rendered as the embed footer timestamp. */
  submittedAt?: string | null;
}

/** The audit fields rendered into the #audit-logs mirror. */
export interface AuditSummary {
  action: string;
  actorLabel: string | null;
  detail: string | null;
  severity: string;
  /** What the action was performed on, when the caller recorded one. */
  targetLabel?: string | null;
  /** ISO-8601 instant the entry was recorded. */
  occurredAt?: string | null;
}

/** Everything an event announcement or reminder needs, resolved by the producer. */
export interface EventSummary {
  title: string;
  description: string | null;
  /** ISO-8601 instant. */
  startsAt: string;
  /** ISO-8601 instant, or null for an open-ended event. */
  endsAt: string | null;
  /** The EVENT's IANA zone — never the server's (T-0154/T-0156). */
  timezone: string;
  bannerUrl: string | null;
  /** Human label: `One-off`, `Recurring (weekly)`, … */
  eventType: string;
  /** How many members have RSVP'd (interested + tentative). */
  rsvpCount: number;
}

/** A decision on an enlistment application. */
export type ApplicationDecisionOutcome = 'approve' | 'decline' | 'hold';

/**
 * A gallery submission as the review / showcase channels need it (T-0195).
 *
 * Every URL here is resolved by the producer from data already on the row —
 * nothing in this module fetches, and nothing guesses. `imageUrl` and
 * `playableUrl` are separate because Discord renders them by different means:
 * an image goes IN the embed, while a video only becomes a player when its bare
 * URL is the message CONTENT.
 */
export interface GallerySummary {
  /** The item's short id, used to build the share link. */
  id: string;
  title: string;
  caption: string | null;
  /** `image` | `video` | `link`, rendered as the "Type" field. */
  type: string;
  authorName: string;
  authorAvatarUrl?: string | null;
  /** Permanent public URL of the still to show in the embed. Null ⇒ no image. */
  imageUrl?: string | null;
  /**
   * A permanent, directly-playable media URL — an uploaded video, or an external
   * clip page Discord already unfurls. Null when there is nothing playable.
   */
  playableUrl?: string | null;
  /** The submitter's own external link, when the item is a link submission. */
  linkUrl?: string | null;
  /** Public share link back to the dashboard, when a site URL is configured. */
  shareUrl?: string | null;
  /** How many files ride along, so a multi-file post says so. */
  fileCount?: number;
  /** ISO-8601 submission instant, rendered as the footer timestamp. */
  submittedAt?: string | null;
  /** Who approved it — showcase posts only. */
  approvedByName?: string | null;
}

/**
 * Drop empty/whitespace-only optional answers instead of rendering a blank
 * field. Discord REJECTS a field with an empty value (`50035`), so this is not
 * cosmetic — an unanswered optional question would fail the whole post.
 */
function field(
  name: string,
  value: string | null | undefined,
  inline = false,
): DiscordEmbedField[] {
  const trimmed = value?.trim();
  return trimmed ? [{ name, value: trimmed, inline }] : [];
}

/** Only http(s) URLs reach Discord; anything else is dropped rather than sent. */
function safeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * A Discord relative timestamp (`<t:UNIX:R>` → "in 3 hours"). Rendered by each
 * reader's own client, so it is correct for everyone without us guessing a
 * viewer timezone.
 */
function relativeTimestamp(instant: Date): string {
  return `<t:${Math.floor(instant.getTime() / 1000)}:R>`;
}

/**
 * The wall clock in the EVENT's zone (T-0154/T-0156). The server runs in UTC
 * containers, so formatting with the process locale would print a time nobody
 * involved with the event recognises. An invalid IANA zone degrades to UTC,
 * mirroring `resolveEventInstant`.
 *
 * Not delegated to `src/events/event-time.ts`: those helpers convert instants
 * (`resolveEventInstant`, `reanchorInstant`) or format the UTC field-view
 * (`storedWallClock`); none renders a DISPLAY wall clock in an arbitrary zone.
 * Importing the events module here would also invert the dependency — events
 * depends on discord, not the other way round. The invalid-zone degradation is
 * kept byte-identical to theirs on purpose.
 */
function wallClockIn(instant: Date, timezone: string): string {
  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';
  return DateTime.fromJSDate(instant, { zone }).toFormat("cccc d LLLL yyyy 'at' HH:mm ZZZZ");
}

/** `2h 30m` / `45m` / `Open-ended` — computed in the event's own zone. */
function durationLabel(startsAt: Date, endsAt: Date | null, timezone: string): string {
  if (!endsAt) return 'Open-ended';
  const zone = DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';
  const diff = DateTime.fromJSDate(endsAt, { zone })
    .diff(DateTime.fromJSDate(startsAt, { zone }), ['hours', 'minutes'])
    .toObject();
  const hours = Math.max(0, Math.floor(diff.hours ?? 0));
  const minutes = Math.max(0, Math.round(diff.minutes ?? 0));
  if (hours === 0 && minutes === 0) return 'Instant';
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : ''].filter(Boolean).join(' ');
}

/** Parse an ISO instant defensively — a bad string must never fail a notification. */
function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ── Composers (T-0173 / T-0174 / T-0175) ─────────────────────────────────────
//
// Every outbound notification is composed HERE. Before this, the enlistment and
// audit texts lived in DiscordSyncService while the event, decision, gallery and
// welcome texts lived in four OTHER services — so "what does a notification look
// like?" had five answers and no single place to change the house style. These
// functions are pure (inputs → embed) and every one of them ends in clampEmbed,
// so no composer can emit an embed Discord will refuse.

/** The #new-enlistments post for a freshly submitted application (T-0173). */
export function buildEnlistmentEmbed(s: EnlistmentSummary, brand: RegimentBrand): DiscordEmbed {
  const submittedAt = toDate(s.submittedAt);
  return clampEmbed({
    title: '📋 New enlistment application',
    description: `**${s.applicantName}** has applied to ${brand.name}.`,
    color: brandColour(brand),
    thumbnailUrl: safeUrl(s.avatarUrl),
    timestamp: (submittedAt ?? new Date()).toISOString(),
    fields: [
      ...field('In-game name', s.inGameName, true),
      ...field('Current regiment', s.currentRegiment, true),
      ...field('How they found us', s.howFound),
      ...field('Preferred classes', s.preferredClasses, true),
      ...field('Wants to improve', s.skillsToImprove, true),
      ...field('Representative note', s.representativeNote),
    ],
    footer: { text: brand.name },
  });
}

/**
 * The house wording for a decision DM when the deciding officer wrote nothing.
 *
 * This used to live in ApplicationsService as `defaultDecisionMessage`. It is
 * message copy, so it belongs with the other message copy — and moving it is
 * what lets ApplicationsService drop its regiment-name lookup entirely.
 */
export function defaultDecisionMessage(
  outcome: ApplicationDecisionOutcome,
  regimentName: string,
): string {
  switch (outcome) {
    case 'approve':
      return `Your application to ${regimentName} has been approved - welcome aboard! Check the dashboard for your next steps.`;
    case 'decline':
      return `Thank you for your interest in ${regimentName}. After review, your application was not successful at this time.`;
    case 'hold':
      return `Your application to ${regimentName} is on hold pending further review. We will be in touch soon.`;
  }
}

/**
 * The applicant's approve/decline/hold DM (T-0173).
 *
 * ⚠️ THE APPLICANT SEES `message` AND NOTHING ELSE (T-0182). The staff console
 * offers the deciding officer exactly two boxes — "User message", which IS this
 * `message`, and "Moderator note", which is badged *Staff only* and promises
 * "the applicant is never shown this note". This embed used to carry a second
 * "Note from the reviewing officer" field fed from `declineReason ?? moderatorNote`,
 * which broke that promise: the internal note was DM'd verbatim to the person it
 * was written about.
 *
 * So this composer takes NO second text input. That is deliberate and structural
 * — a future caller cannot re-introduce the leak by passing an extra argument,
 * because there is no argument to pass. `declineReason` and `moderatorNote` stay
 * persisted and audited for staff; they are simply not inputs here.
 */
export function buildDecisionEmbed(input: {
  outcome: ApplicationDecisionOutcome;
  brand: RegimentBrand;
  /**
   * The ONLY applicant-visible text: the officer's "User message" when they
   * wrote one, otherwise {@link defaultDecisionMessage}.
   */
  message: string;
}): DiscordEmbed {
  const { outcome, brand, message } = input;
  const titles: Record<ApplicationDecisionOutcome, string> = {
    approve: `✅ Your application to ${brand.name} was approved`,
    decline: `Your application to ${brand.name} was not successful`,
    hold: `⏳ Your application to ${brand.name} is on hold`,
  };
  return clampEmbed({
    title: titles[outcome],
    description: message,
    color: OUTCOME_COLOURS[outcome],
    thumbnailUrl: safeUrl(brand.crestUrl),
    timestamp: new Date().toISOString(),
    footer: { text: brand.name },
  });
}

/**
 * The gallery review / showcase channel post (T-0195).
 *
 * ⚠️ WHAT DISCORD WILL AND WILL NOT RENDER, because it decides this shape:
 *  - An IMAGE url set as the embed image renders inline. That covers image
 *    submissions and the poster frame of a video.
 *  - A VIDEO never plays from inside an embed, no matter which field it is put
 *    in. Discord only builds a player from a bare media URL in the message
 *    CONTENT. So the playable url is NOT in this embed at all — the producer
 *    carries it separately and the worker sends it as its own message.
 *  - An EXTERNAL link (YouTube, Medal) is unfurled by Discord itself from the
 *    bare URL, and its own unfurl is richer than anything reconstructible here.
 *    So the link is surfaced as a field and left for Discord to expand rather
 *    than being scraped and re-rendered — which is also why no external host is
 *    ever fetched to build this.
 *
 * `pending` posts go to a STAFF channel and say so; `approved` posts go to a
 * public one and name the officer who passed it.
 */
export function buildGalleryEmbed(
  item: GallerySummary,
  brand: RegimentBrand,
  stage: 'pending' | 'approved',
): DiscordEmbed {
  const submittedAt = toDate(item.submittedAt);
  const extra = (item.fileCount ?? 0) - 1;
  return clampEmbed({
    title:
      stage === 'pending'
        ? `🖼️ Gallery submission awaiting review — ${item.title}`
        : `🖼️ ${item.title}`,
    description: item.caption ?? undefined,
    // The share link is the embed's own url, so the title is clickable straight
    // through to the item rather than needing a field of its own.
    url: safeUrl(item.shareUrl),
    color: stage === 'pending' ? OUTCOME_COLOURS.hold : brandColour(brand),
    imageUrl: safeUrl(item.imageUrl),
    thumbnailUrl: safeUrl(item.authorAvatarUrl),
    timestamp: (submittedAt ?? new Date()).toISOString(),
    fields: [
      ...field('Submitted by', item.authorName, true),
      ...field('Type', item.type, true),
      ...field('Approved by', stage === 'approved' ? item.approvedByName : null, true),
      // Only when there IS more than one — a single-file post saying "1 file"
      // is noise in a channel that gets one of these per submission.
      ...field('Files', extra > 0 ? `${extra + 1} (first shown)` : null, true),
      ...field('Link', safeUrl(item.linkUrl), false),
    ],
    footer: { text: brand.name },
  });
}

/** The gallery moderation-outcome DM (T-0173). */
export function buildGalleryDeclineEmbed(input: {
  brand: RegimentBrand;
  /** The submission's title. */
  title: string;
  /** The moderator's reason, when they gave one. */
  reason?: string | null;
}): DiscordEmbed {
  const { brand, title, reason } = input;
  return clampEmbed({
    title: 'Your gallery submission was declined',
    description: `“${title}” was reviewed and not published to the ${brand.name} gallery.`,
    color: OUTCOME_COLOURS.decline,
    thumbnailUrl: safeUrl(brand.crestUrl),
    timestamp: new Date().toISOString(),
    fields: field('Reason', reason),
    footer: { text: brand.name },
  });
}

/**
 * The event-announcement / event-reminder embed (T-0174).
 *
 * ⚠️ The event's server PASSWORD is deliberately absent from every branch of
 * this function and is not even accepted as an input: {@link EventSummary} has
 * no field to carry it. An announcement channel is readable by the whole guild,
 * while the password is gated behind an RSVP in the app — leaking it here would
 * silently retire that gate.
 */
export function buildEventEmbed(
  event: EventSummary,
  brand: RegimentBrand,
  reminder: { minutesBefore: number } | null = null,
): DiscordEmbed {
  const startsAt = toDate(event.startsAt) ?? new Date();
  const endsAt = toDate(event.endsAt);
  const title = reminder
    ? `⏰ Reminder — ${event.title} starts ${leadLabel(reminder.minutesBefore)}`
    : `📅 New event: ${event.title}`;
  return clampEmbed({
    title,
    description: event.description ?? undefined,
    // A reminder must be tellable from the original announcement at a glance,
    // so it changes BOTH the title framing and the colour.
    color: reminder ? OUTCOME_COLOURS.reminder : OUTCOME_COLOURS.event,
    imageUrl: safeUrl(event.bannerUrl),
    timestamp: startsAt.toISOString(),
    fields: [
      {
        name: 'Starts',
        value: `${relativeTimestamp(startsAt)}\n${wallClockIn(startsAt, event.timezone)}`,
      },
      { name: 'Duration', value: durationLabel(startsAt, endsAt, event.timezone), inline: true },
      { name: 'Type', value: event.eventType, inline: true },
      { name: 'RSVPs', value: String(event.rsvpCount), inline: true },
    ],
    footer: { text: brand.name },
  });
}

/** `in 15 minutes` / `in 2 hours` / `in 1 day` — the reminder's lead time. */
function leadLabel(minutes: number): string {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60);
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(minutes / 1440);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The #audit-logs channel mirror (T-0175). Deliberately COMPACT: this channel
 * receives an entry for every audited mutation in the app, so field sprawl would
 * make it unreadable within a day. One embed, at most three short inline fields,
 * no thumbnail, no image.
 */
export function buildAuditEmbed(entry: AuditSummary): DiscordEmbed {
  const occurredAt = toDate(entry.occurredAt);
  return clampEmbed({
    title: entry.action,
    description: entry.detail ?? undefined,
    color: SEVERITY_COLOURS[entry.severity] ?? SEVERITY_COLOURS.info,
    timestamp: (occurredAt ?? new Date()).toISOString(),
    fields: [
      { name: 'Actor', value: entry.actorLabel?.trim() || 'system', inline: true },
      ...field('Target', entry.targetLabel, true),
      { name: 'Severity', value: entry.severity, inline: true },
    ],
  });
}

/**
 * The placeholder tokens an admin may use in the configurable welcome message
 * (T-0185), paired with what each one renders. This array IS the admin-facing
 * contract: it is what the settings API documents and what the settings editor
 * shows as its hint, so the three never drift.
 *
 * Deliberately SHORT. Every token here is resolvable from data the welcome
 * producer already holds, so none of them costs a query or can render stale.
 */
export const WELCOME_TOKENS = [
  { token: '{user}', renders: 'A mention of the member who just joined' },
  { token: '{regiment}', renders: 'The regiment name' },
] as const;

/**
 * Expand {@link WELCOME_TOKENS} in an admin-authored welcome message (T-0185).
 *
 * Unknown tokens are left VERBATIM — `{nope}` stays `{nope}` rather than
 * becoming an empty string, so a typo is visible to the admin who made it
 * instead of quietly deleting part of their greeting. A message containing no
 * token is returned byte-identical.
 *
 * SAFETY: the only thing this can inject is `<@snowflake>` built from digits we
 * strip out of the id ourselves, and the regiment's own name. It cannot
 * introduce a ping the admin did not already have, because the expanded text is
 * only ever used as an embed DESCRIPTION — Discord does not resolve mentions
 * inside an embed, so `@everyone` typed into the welcome message renders as
 * literal text and notifies nobody. `notification-embeds.spec.ts` and
 * `discord-sync.service.spec.ts` pin that the welcome text never reaches a
 * message `content`, which is the only place it could ping.
 */
export function expandWelcomeTokens(
  message: string,
  context: { discordUserId?: string | null; regimentName: string },
): string {
  // Discord ids are snowflakes; anything else in that field is not an id and is
  // not worth rendering as a broken mention chip.
  const id = (context.discordUserId ?? '').replace(/\D/g, '');
  const values: Record<string, string> = {
    '{user}': id ? `<@${id}>` : 'recruit',
    '{regiment}': context.regimentName,
  };
  // One pass, so a value that happens to contain a token is not re-expanded.
  return message.replace(/\{user\}|\{regiment\}/g, (match) => values[match] ?? match);
}

/**
 * The guild-join welcome (T-0175): branded, and carrying the admin's message and
 * NOTHING ELSE.
 *
 * ⚠️ NO HOUSE COPY IS APPENDED. This used to add a hardcoded "Next steps" field
 * ("Read the pinned rules…", "Submit an enlistment application…", "RSVP to an
 * upcoming event…") underneath the configured greeting, so an admin who wrote a
 * complete welcome got it followed by three bullets they never asked for and
 * could not remove from the settings screen. The message box is the whole
 * message; if a regiment wants next steps, they type them.
 *
 * Token expansion happens HERE rather than in the producer (T-0185) so it is
 * structurally impossible for an expansion to escape the embed limits: this
 * function ends in `clampEmbed`, so a message that grows past the description
 * budget is truncated like any other, and the 512-character validator on the
 * SAVED text stays a limit on what the admin types rather than on what renders.
 */
export function buildWelcomeEmbed(input: {
  brand: RegimentBrand;
  /** The configured welcome message, or the default. May contain tokens. */
  message: string;
  /** The joining member, used to expand `{user}`. Null ⇒ a neutral greeting. */
  discordUserId?: string | null;
  /** The regiment dashboard URL, when one is configured. */
  siteUrl?: string | null;
}): DiscordEmbed {
  const { brand, message, discordUserId, siteUrl } = input;
  const body = expandWelcomeTokens(message, {
    discordUserId,
    regimentName: brand.name,
  });
  return clampEmbed({
    title: `Welcome to ${brand.name}`,
    description: body,
    url: safeUrl(siteUrl),
    color: OUTCOME_COLOURS.welcome,
    // The banner is the brand statement; the crest is the fallback identity mark
    // when no banner is configured. A member with no avatar is irrelevant here —
    // nothing in this embed reads the joining member's profile.
    imageUrl: safeUrl(brand.bannerUrl),
    thumbnailUrl: safeUrl(brand.crestUrl),
    footer: { text: brand.name },
  });
}
