import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /api/applications/:id/decline. */
export class DeclineApplicationDto {
  // STAFF-ONLY, like `note` (T-0182). This was once documented as "shown" to the
  // applicant, and the decision DM did render it — but it is stored on
  // `declineReason`, which the applicant projection deliberately omits, so the
  // DM was the one surface contradicting the rest of the system. It no longer
  // leaves the staff console: use `discordDmMessage` for anything the applicant
  // should read.
  @ApiPropertyOptional({
    maxLength: 255,
    description:
      'Optional internal reason recorded for the decline (staff-only; never shown to the applicant)',
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
