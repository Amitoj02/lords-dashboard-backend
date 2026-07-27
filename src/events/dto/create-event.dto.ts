import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { Platform, RecurrenceCadence } from '../../common/enums';
import { IsIanaTimezone } from './is-iana-timezone.validator';

/**
 * A Discord snowflake (17–20 digits) OR an empty string, matching the bot
 * settings DTO. Empty is how the authoring form CLEARS the ping role; a
 * non-empty value must still be well formed, so a typo cannot be persisted and
 * then rendered into a live channel as a broken `<@&nonsense>` chip.
 */
const DISCORD_SNOWFLAKE_OR_EMPTY = /^(\d{17,20})?$/;

/**
 * Body for POST /api/events. The regiment and creator are taken from the JWT,
 * not the body. `timezone` and `notifyOffsets` fall back to the regiment's
 * settings when omitted — those defaults are applied server-side, so no property
 * initializers are used here (that would leak defaults through PartialType into
 * the PATCH DTO). Creation always publishes directly (there is no draft state).
 * Supplying `recurrenceCadence` makes the event an active recurring template
 * whose future occurrences are materialized by the recurrence scheduler.
 * `serverPassword` is accepted as plaintext and encrypted at rest; it is never
 * echoed back.
 */
export class CreateEventDto {
  @ApiProperty({ maxLength: 160, example: 'Friday Night Line Battle' })
  @IsString()
  @MaxLength(160)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Storage key of an uploaded banner image (from POST /storage/uploads)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  bannerKey?: string;

  @ApiProperty({
    description:
      'ISO 8601 start timestamp. A naive wall clock ("2026-07-20T21:57:00") is read in the ' +
      "event's timezone; an offset-qualified value (Z or ±HH:MM) is a true instant and wins " +
      'over `timezone`.',
  })
  @IsDateString()
  startsAt: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 end timestamp (open-ended when omitted); resolved like `startsAt`',
  })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({
    maxLength: 40,
    description:
      'IANA timezone; defaults to the regiment setting. Also the zone naive timestamps above ' +
      'are resolved in.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Validate(IsIanaTimezone)
  timezone?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  recurrenceRule?: string;

  @ApiPropertyOptional({
    enum: RecurrenceCadence,
    description:
      'When set, creates an active recurring template; the scheduler materializes future occurrences at this cadence.',
  })
  @IsOptional()
  @IsEnum(RecurrenceCadence)
  recurrenceCadence?: RecurrenceCadence;

  @ApiPropertyOptional({
    maxLength: 20,
    description:
      'Discord role to ping when this event is announced. Pinged EXACTLY ONCE, when the ' +
      'announcement is posted — never on the pre-event reminder and never when the ' +
      "announcement's RSVP list is re-rendered. Send '' to clear it. A recurring template " +
      'passes it to every occurrence, each of which pings once.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(DISCORD_SNOWFLAKE_OR_EMPTY, {
    message: 'announceRoleId must be a Discord snowflake (17–20 digits)',
  })
  announceRoleId?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serverName?: string;

  @ApiPropertyOptional({
    description: 'Plaintext server password; encrypted at rest and never returned in listings',
  })
  @IsOptional()
  @IsString()
  serverPassword?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  serverRegion?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedAttendance?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  attendanceGoal?: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  twitchUrl?: string;

  @ApiPropertyOptional({
    enum: Platform,
    isArray: true,
    description: 'Platforms the event runs on',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(Platform, { each: true })
  platforms?: Platform[];

  @ApiPropertyOptional({ type: [String], maxItems: 10, description: 'Free-form tags (max 10)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: [Number], description: 'Notification lead times in minutes' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  notifyOffsets?: number[];
}
