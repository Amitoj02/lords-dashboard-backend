import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EventStatus, Platform, RecurrenceCadence, RsvpStatus } from '../../common/enums';
import { RegimentEvent } from '../entities/event.entity';

/** RSVP tallies for an event, broken down by intent. */
export class RsvpCountsDto {
  @ApiProperty()
  interested: number;

  @ApiProperty()
  tentative: number;

  @ApiProperty()
  declined: number;

  @ApiProperty()
  neutral: number;
}

/** The caller's own RSVP to an event (member view only). */
export class MyRsvpDto {
  @ApiProperty({ enum: RsvpStatus })
  status: RsvpStatus;

  @ApiProperty({ nullable: true })
  reminderOffsetMinutes: number | null;
}

/** Inputs to {@link EventDto.from}: the batched child collections and counts. */
export interface EventDtoOptions {
  platforms: Platform[];
  tags: string[];
  rsvpCounts: RsvpCountsDto;
  attendeesCount: number;
  /** Notification lead times (member view only). */
  notifyOffsets?: number[];
  /** When true, include member-only fields (server binding, draft flags, …). */
  includeServer?: boolean;
  /** The caller's own RSVP, when known (member view only). */
  myRsvp?: MyRsvpDto | null;
}

/**
 * Projection of a {@link RegimentEvent}. The same class serves both the public
 * view and the authenticated member view: `includeServer` unlocks the
 * member-only fields — turnout (RSVP counts, attendance), draft/archive state,
 * recurrence internals and timestamps.
 *
 * The server NAME and REGION are public (T-0298): they are how somebody turns
 * up, and this page's job is to advertise a muster to people who are not in the
 * regiment yet. The server PASSWORD is NEVER projected here on any branch; it is
 * returned only by the dedicated reveal endpoint, behind a session, the
 * `reveal_event_passwords` capability and a live non-declined RSVP.
 */
export class EventDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  bannerUrl: string | null;

  @ApiProperty({ description: 'ISO timestamp the event starts' })
  startsAt: string;

  @ApiProperty({
    nullable: true,
    description: 'ISO timestamp the event ends (open-ended when null)',
  })
  endsAt: string | null;

  @ApiProperty()
  timezone: string;

  @ApiProperty({ enum: EventStatus })
  status: EventStatus;

  @ApiProperty()
  isRecurring: boolean;

  @ApiProperty({ nullable: true })
  outcome: string | null;

  @ApiProperty({ nullable: true })
  twitchUrl: string | null;

  @ApiProperty({ enum: Platform, isArray: true })
  platforms: Platform[];

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({
    description:
      'Whether a game server is bound to this event. Kept alongside the now-public ' +
      '`serverName` so a caller can distinguish "no server bound" from "bound but blank".',
  })
  hasServerName: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'The game server this event runs on. PUBLIC (T-0298) — it is how somebody turns up, ' +
      'and an event page that advertises a muster to people outside the regiment withheld ' +
      'the one detail that let them come. The PASSWORD is not here on any branch.',
  })
  serverName: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Region the server runs in (e.g. "EU"). Public, for the same reason as the name.',
  })
  serverRegion: string | null;

  @ApiProperty({
    description:
      'Whether a server password is set. Public: the password is never projected anywhere ' +
      '(only the capability-gated reveal endpoint returns it); the flag lets the UI badge a ' +
      'protected event and hide the reveal control on passwordless ones.',
  })
  hasServerPassword: boolean;

  // ── Member-only fields (present only when includeServer is set) ──────────────

  @ApiPropertyOptional({
    type: RsvpCountsDto,
    description: 'Member view only (T-0215) — turnout is not public calendar information',
  })
  rsvpCounts?: RsvpCountsDto;

  @ApiPropertyOptional({ description: 'Number of confirmed attendees. Member view only.' })
  attendeesCount?: number;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  expectedAttendance?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  attendanceGoal?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Discord role pinged when the event was announced (member view only). Never projected ' +
      'publicly — it is guild configuration, not calendar information.',
  })
  announceRoleId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  recurrenceRule?: string | null;

  @ApiPropertyOptional({
    enum: RecurrenceCadence,
    nullable: true,
    description: 'Recurring cadence of a template (member view only)',
  })
  recurrenceCadence?: RecurrenceCadence | null;

  @ApiPropertyOptional({
    description: 'Whether a recurring template is still generating occurrences (member view only)',
  })
  recurrenceActive?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'On a generated occurrence, its template id (member view only)',
  })
  recurrenceTemplateId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  createdByMemberId?: string | null;

  @ApiPropertyOptional({
    type: [Number],
    description: 'Notification lead times (member view only)',
  })
  notifyOffsets?: number[];

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  startedAt?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  inLineCount?: number | null;

  @ApiPropertyOptional({ description: 'Member view only' })
  isDraft?: boolean;

  @ApiPropertyOptional({ description: 'Member view only' })
  isArchived?: boolean;

  @ApiPropertyOptional({ description: 'ISO timestamp the event was created (member view only)' })
  createdAt?: string;

  @ApiPropertyOptional({
    description: 'ISO timestamp the event was last updated (member view only)',
  })
  updatedAt?: string;

  @ApiPropertyOptional({
    type: MyRsvpDto,
    nullable: true,
    description: "The caller's own RSVP (member view only)",
  })
  myRsvp?: MyRsvpDto | null;

  /**
   * Build the projection from an event plus its batched child collections/counts.
   * Public callers pass `includeServer: false` (the default), which omits every
   * member-only field: turnout, draft/archive state, recurrence internals,
   * timestamps and the caller's own RSVP.
   *
   * The server name and region are set unconditionally (T-0298). The password is
   * not set on any branch — it is not a field on this class at all, which is the
   * strongest form the guarantee can take: there is no `includeServer` value, no
   * option object and no future call site that can make this DTO carry one.
   */
  static from(event: RegimentEvent, opts: EventDtoOptions): EventDto {
    const dto = new EventDto();
    dto.id = event.id;
    dto.title = event.title;
    dto.description = event.description;
    dto.bannerUrl = event.bannerUrl;
    dto.startsAt = event.startsAt.toISOString();
    dto.endsAt = event.endsAt ? event.endsAt.toISOString() : null;
    dto.timezone = event.timezone;
    dto.status = event.status;
    dto.isRecurring = event.isRecurring;
    dto.outcome = event.outcome;
    dto.twitchUrl = event.twitchUrl;
    dto.platforms = opts.platforms;
    dto.tags = opts.tags;
    // Presence flags carry no secret, so they are part of the PUBLIC projection
    // (T-0151) — without them the public calendar cannot tell a password-protected
    // event from a plain one. An empty string counts as unset: the encryption
    // transformer nulls an empty password on its way to the DB, so an in-memory
    // '' (a just-saved entity, a legacy row) is never a real binding.
    dto.hasServerName = !!event.serverName;
    dto.hasServerPassword = !!event.serverPassword;
    // ── THE SERVER BINDING IS PUBLIC (T-0298) ────────────────────────────────
    // Moved out of the `includeServer` branch below. `includeServer` is a single
    // flag doing double duty — it gates turnout AND the server binding — so this
    // could not be done by flipping it: that would have published RSVP counts
    // and unit strength along with the server name.
    //
    // The PASSWORD does not move and cannot: it is not written into this DTO on
    // any branch, on purpose. `RevealedPasswordDto` is the only projection that
    // carries it, behind a session, the `reveal_event_passwords` capability AND
    // a live non-declined RSVP.
    dto.serverName = event.serverName || null;
    dto.serverRegion = event.serverRegion || null;

    if (opts.includeServer) {
      // TURNOUT MOVED BEHIND THE MEMBER PROJECTION (T-0215). Now that the events
      // calendar is a public, indexed page rather than a link members shared with
      // each other, `rsvpCounts` + `attendeesCount` + `expectedAttendance` +
      // `attendanceGoal` amount to publishing unit strength and turnout history
      // — a rival regiment reading readiness off one anonymous GET. `outcome`
      // stays public on purpose: a match result is the part worth bragging about
      // and the part worth indexing.
      dto.rsvpCounts = opts.rsvpCounts;
      dto.attendeesCount = opts.attendeesCount;
      dto.expectedAttendance = event.expectedAttendance;
      dto.attendanceGoal = event.attendanceGoal;
      dto.announceRoleId = event.announceRoleId;
      dto.recurrenceRule = event.recurrenceRule;
      dto.recurrenceCadence = event.recurrenceCadence;
      dto.recurrenceActive = event.recurrenceActive;
      dto.recurrenceTemplateId = event.recurrenceTemplateId;
      dto.createdByMemberId = event.createdByMemberId;
      dto.notifyOffsets = opts.notifyOffsets ?? [];
      dto.startedAt = event.startedAt ? event.startedAt.toISOString() : null;
      dto.inLineCount = event.inLineCount;
      dto.isDraft = event.isDraft;
      dto.isArchived = event.isArchived;
      dto.createdAt = event.createdAt.toISOString();
      dto.updatedAt = event.updatedAt.toISOString();
      dto.myRsvp = opts.myRsvp ?? null;
    }

    return dto;
  }
}
