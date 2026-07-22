import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /api/applications/:id/decline. */
export class DeclineApplicationDto {
  @ApiPropertyOptional({
    maxLength: 255,
    description: 'Optional reason shown/recorded for the decline',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  // The staff console sends the officer's internal note on every decision, hold
  // and decline alike (T-0248). Without this field `forbidNonWhitelisted` would
  // 400 the whole decline, so it is accepted here and persisted to the same
  // moderatorNote column hold() writes.
  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Optional internal moderator note (staff-only; never shown to the applicant)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Optional custom message DM’d to the applicant instead of the default template. ' +
      'Stored and surfaced back to the applicant as `userMessage`; blank leaves any previously stored message intact.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  discordDmMessage?: string;
}
