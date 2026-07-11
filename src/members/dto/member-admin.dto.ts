import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MemberRole } from '../../common/enums';

/** Change a member's rank (admin). */
export class ChangeRankDto {
  @ApiProperty({ format: 'uuid', description: 'The target rank id (must belong to the regiment)' })
  @IsUUID()
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
  @ApiProperty({ format: 'uuid', description: 'The medal id from the catalogue' })
  @IsUUID()
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
