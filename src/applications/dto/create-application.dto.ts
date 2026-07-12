import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /api/applications, matching the regiment's "Application for
 * Enlistment" form (T-0039). The submitter is the authenticated Discord identity
 * (Applicant role); regiment + identity are taken from the JWT, not the body.
 * There is no age field here — the 18+ requirement is a client-side terms
 * attestation only (T-0039 Q2).
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

  @ApiPropertyOptional({ maxLength: 64, example: '@janedoe' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  discordTag?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 255,
    description: 'The applicant’s current/most-recent regiment ("None" if unaffiliated).',
    example: 'None',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  currentRegiment: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'How did you find/hear about the Lords of Holdfast? (free text)',
    example: 'A friend in the Discord invited me.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  howFound: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    description: 'Which classes do you prefer to play?',
    example: 'Line Infantry, Rifleman',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  preferredClasses: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    description: 'What skills would you like to improve?',
    example: 'Melee duelling and staying in the line.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  skillsToImprove: string;

  @ApiProperty({
    description:
      'Must be true — the applicant confirms they are interested and will enlist in-game.',
  })
  @IsBoolean()
  @Equals(true, { message: 'interestConfirmed must be true' })
  interestConfirmed: boolean;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Optional note if a representative/guest is applying on someone’s behalf.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  representativeNote?: string;
}
