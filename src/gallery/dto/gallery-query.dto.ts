import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { GalleryType } from '../../common/enums';

/** Query params for the gallery list endpoints (public feed + moderation queue). */
export class GalleryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: GalleryType, description: 'Filter by item type' })
  @IsOptional()
  @IsEnum(GalleryType)
  type?: GalleryType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by associated event' })
  @IsOptional()
  @IsUUID()
  eventId?: string;
}
