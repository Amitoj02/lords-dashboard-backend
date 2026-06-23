import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Equals,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApplicantType, HowFound, Platform } from '../../common/enums';

/**
 * Body for POST /api/applications. The submitter is the authenticated Discord
 * identity (Applicant role); regiment + identity are taken from the JWT, not the
 * body. `ageConfirmed` MUST be true — a false value is rejected by validation.
 */
export class CreateApplicationDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: 'Jane Doe' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  applicantName: string;

  @ApiProperty({ minLength: 1, maxLength: 120, example: 'JaneTheGreat' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  inGameName: string;

  @ApiProperty({ enum: Platform })
  @IsEnum(Platform)
  platform: Platform;

  @ApiPropertyOptional({ enum: ApplicantType, default: ApplicantType.Applicant })
  @IsOptional()
  @IsEnum(ApplicantType)
  applicantType?: ApplicantType;

  @ApiPropertyOptional({ maxLength: 64, example: '@janedoe' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  discordTag?: string;

  @ApiPropertyOptional({ maxLength: 40, example: 'America/Toronto' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  timezone?: string;

  @ApiProperty({ minLength: 1, maxLength: 2000, description: 'Why do you want to join?' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  whyJoin: string;

  @ApiProperty({ enum: HowFound })
  @IsEnum(HowFound)
  howFound: HowFound;

  @ApiPropertyOptional({ maxLength: 600 })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  priorExperience?: string;

  @ApiProperty({
    description: 'Must be true — the applicant confirms they meet the age requirement',
  })
  @IsBoolean()
  @Equals(true, { message: 'ageConfirmed must be true' })
  ageConfirmed: boolean;
}
