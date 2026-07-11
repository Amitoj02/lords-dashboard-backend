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
}
