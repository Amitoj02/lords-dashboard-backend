import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { GalleryMediaType, GalleryType } from '../../common/enums';

/**
 * One file in a multi-file submission. `sizeBytes` is a numeric string (the
 * column is a bigint) — the server enforces the per-type size caps from
 * regiment_settings when it is provided.
 */
export class GalleryFileInputDto {
  @ApiProperty({ minLength: 1, maxLength: 255, example: 'charge.png' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Storage key of the uploaded file (from POST /storage/uploads)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  key?: string;

  @ApiProperty({ enum: GalleryMediaType })
  @IsEnum(GalleryMediaType)
  mediaType: GalleryMediaType;

  @ApiPropertyOptional({ description: 'Size in bytes (bigint as a string)', example: '2048000' })
  @IsOptional()
  @IsNumberString()
  sizeBytes?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Duration in seconds (video only)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSeconds?: number;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  caption?: string;

  @ApiPropertyOptional({ maxLength: 7, example: '#1a2b3c', description: 'Dominant color hex' })
  @IsOptional()
  @IsString()
  @MaxLength(7)
  thumbnailColor?: string;
}

/**
 * Body for POST /api/gallery. The author + regiment are taken from the JWT, not
 * the body. New submissions land in the moderation queue (status Pending) unless
 * the regiment auto-approves trusted staff — that decision is made server-side.
 */
export class CreateGalleryItemDto {
  @ApiProperty({ minLength: 1, maxLength: 160, example: 'The charge at dawn' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  caption?: string;

  @ApiProperty({ enum: GalleryType })
  @IsEnum(GalleryType)
  type: GalleryType;

  @ApiPropertyOptional({ maxLength: 512, description: 'External link (for link-type items)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  linkUrl?: string;

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  thumbnailUrl?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Associate the item with an event' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiPropertyOptional({ type: [GalleryFileInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GalleryFileInputDto)
  files?: GalleryFileInputDto[];

  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Member ids to tag' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  taggedMemberIds?: string[];
}
