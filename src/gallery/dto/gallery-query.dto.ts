import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { GalleryStatus, GalleryType } from '../../common/enums';

/** Query params for the gallery list endpoints (public feed + moderation queue). */
export class GalleryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GalleryType, description: 'Filter by item type' })
  @IsOptional()
  @IsEnum(GalleryType)
  type?: GalleryType;

  /**
   * Moderation-queue status filter (pending | approved | declined). Only honored
   * on staff routes; the public feed + authenticated archive always force
   * Approved regardless of this value.
   */
  @ApiPropertyOptional({ enum: GalleryStatus, description: 'Filter by moderation status (staff)' })
  @IsOptional()
  @IsEnum(GalleryStatus)
  status?: GalleryStatus;
}
