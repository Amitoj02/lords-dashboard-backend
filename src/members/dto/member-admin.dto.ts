import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsShortId } from '../../common/ids/short-id';
import { MemberRole } from '../../common/enums';
import { MemberDto } from './member.dto';

/** Change a member's rank (admin). */
export class ChangeRankDto {
  @ApiProperty({ description: 'The target rank id (must belong to the regiment)' })
  @IsShortId()
  rankId: string;

  @ApiPropertyOptional({
    maxLength: 255,
    description: 'Optional note recorded on the service record',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/** Change a member's role (admin). */
export class ChangeRoleDto {
  @ApiProperty({ enum: MemberRole })
  @IsEnum(MemberRole)
  role: MemberRole;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/** Award a medal to a member (repeatable). */
export class AwardMedalDto {
  @ApiProperty({ description: 'The medal id from the catalogue' })
  @IsShortId()
  medalId: string;

  @ApiPropertyOptional({ maxLength: 255, description: 'Optional citation for this specific award' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  detail?: string;
}

/** Suspend a member until a given time (admin). */
export class SuspendMemberDto {
  @ApiProperty({ description: 'ISO timestamp the suspension lifts' })
  @IsDateString()
  until: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

/** Ban a member (admin). */
export class BanMemberDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

/**
 * The outcome of a "derive from Discord" run (T-0204).
 *
 * Unlike every other admin action, this one does not return a bare member: the
 * whole point is that the caller did not know what would happen, so the response
 * has to say what it found. "Nothing" is a normal, successful answer — reported
 * as an empty rank + empty medal list with a summary that says so, never as an
 * error — because "their roles already match the roster" is exactly what an
 * admin sweeping a roster needs to hear.
 */
export class DeriveFromDiscordResultDto {
  @ApiProperty({ type: MemberDto, description: 'The member as they stand after the derive' })
  member: MemberDto;

  @ApiProperty({
    nullable: true,
    description: 'The rank adopted from Discord, or null when the rank was left alone',
  })
  rank: string | null;

  @ApiProperty({
    type: [String],
    description: 'Titles of the medals newly credited (ones already held are skipped)',
  })
  medals: string[];

  @ApiProperty({
    description: 'One human sentence naming what was derived — the same one written to the audit',
  })
  summary: string;
}

/** GDPR: request deferred account deletion (self-service). */
export class DeletionRequestDto {
  @ApiProperty({ description: 'Acknowledge the deletion is permanent' })
  @IsBoolean()
  acknowledgePermanent: boolean;

  @ApiProperty({ description: 'Acknowledge a data export was downloaded first' })
  @IsBoolean()
  acknowledgeDataDownloaded: boolean;
}

/** GDPR: confirm a pending deletion request with its token. */
export class ConfirmDeletionDto {
  @ApiProperty({ description: 'The confirmation token issued when the request was created' })
  @IsString()
  @MaxLength(64)
  token: string;
}
