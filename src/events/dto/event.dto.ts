import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EventStatus, Platform, RsvpStatus } from '../../common/enums';
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
 * view and the authenticated member view: public callers get only the safe
 * fields (server name/region/password are REDACTED — omitted entirely), while
 * `includeServer` unlocks the member-only fields. The server password is NEVER
 * projected here; it is only returned by the dedicated reveal endpoint.
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
  expectedAttendance: number | null;

  @ApiProperty({ nullable: true })
  attendanceGoal: number | null;

  @ApiProperty({ nullable: true })
  outcome: string | null;

  @ApiProperty({ nullable: true })
  twitchUrl: string | null;

  @ApiProperty({ enum: Platform, isArray: true })
  platforms: Platform[];

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ type: RsvpCountsDto })
  rsvpCounts: RsvpCountsDto;

  @ApiProperty({ description: 'Number of confirmed attendees' })
  attendeesCount: number;

  // ── Member-only fields (present only when includeServer is set) ──────────────

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  serverName?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  serverRegion?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Member view only' })
  recurrenceRule?: string | null;

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
   * member-only field so the raw entity's server binding never leaks. When
   * `includeServer` is set the server name/region are added — but never the
   * password, which only the reveal endpoint returns.
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
    dto.expectedAttendance = event.expectedAttendance;
    dto.attendanceGoal = event.attendanceGoal;
    dto.outcome = event.outcome;
    dto.twitchUrl = event.twitchUrl;
    dto.platforms = opts.platforms;
    dto.tags = opts.tags;
    dto.rsvpCounts = opts.rsvpCounts;
    dto.attendeesCount = opts.attendeesCount;

    if (opts.includeServer) {
      dto.serverName = event.serverName;
      dto.serverRegion = event.serverRegion;
      dto.recurrenceRule = event.recurrenceRule;
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
