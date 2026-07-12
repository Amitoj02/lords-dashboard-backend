import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /api/applications/:id/block — optional internal reason. */
export class BlockApplicantDto {
  @ApiPropertyOptional({
    maxLength: 255,
    description: 'Optional internal reason recorded for the block (not shown to the applicant).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
