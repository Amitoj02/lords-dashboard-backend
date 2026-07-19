import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for PATCH /api/gallery/:id (moderator edit). Deliberately a bespoke class
 * — NOT a PartialType of CreateGalleryItemDto — so only the title, caption and
 * tags are editable: the media itself (type, files, linkUrl, thumbnailUrl) stays
 * immutable once submitted. Every field is optional; an omitted field is left
 * untouched, and `tags` (when present) replaces the existing tag set wholesale.
 */
export class UpdateGalleryItemDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 160,
    description: 'Post title (must be non-empty when present; the column is NOT NULL)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  caption?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 10, description: 'Free-form tags (max 10)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
}
