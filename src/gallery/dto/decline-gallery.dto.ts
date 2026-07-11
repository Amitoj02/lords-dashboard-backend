import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for POST /api/gallery/:id/decline. */
export class DeclineGalleryDto {
  @ApiPropertyOptional({
    maxLength: 255,
    description: 'Optional reason recorded for the decline',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
