import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /api/applications/:id/hold. */
export class HoldApplicationDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Optional moderator note explaining why the application is on hold',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
